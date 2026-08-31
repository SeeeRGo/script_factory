param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'ScriptFactory-Test-UN',
  [int]$Port = 33001
)

$ErrorActionPreference = 'Stop'
$nodeVersion = & node --version
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) {
  throw "Для установки требуется Node.js 24+, найдено: $nodeVersion"
}

Set-Location $ProjectPath
if (-not (Test-Path '.env')) {
  Copy-Item 'windows\.env.example' '.env'
  throw 'Создан .env. Заполните секреты и повторите установку.'
}

$preflight = Join-Path $ProjectPath 'windows\preflight.ps1'
& $preflight -ProjectPath $ProjectPath -Port $Port
if ($LASTEXITCODE -ne 0) { throw 'Windows preflight завершился с ошибкой' }

$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'npm ci завершился с ошибкой' }

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = (Get-Command powershell.exe).Source
$startScript = Join-Path $ProjectPath 'windows\start-worker.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -ProjectPath `"$ProjectPath`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

try {
  if (-not (Get-NetFirewallRule -DisplayName 'Script Factory API' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Script Factory API' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  }
} catch {
  Write-Warning "Правило Firewall не создано. Выполните скрипт от администратора или откройте TCP $Port вручную."
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Задача $TaskName запущена. Проверка: http://localhost:$Port/health"
