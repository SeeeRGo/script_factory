param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvFile = '',
  [string]$TaskName = 'ScriptFactory-Test-UN',
  [string]$RunAsUser = '',
  [switch]$SkipDependencyInstall,
  [int]$Port = 33001
)

$ErrorActionPreference = 'Stop'
# Bind the default to this machine, regardless of the installer account/domain.
$userId = if ([string]::IsNullOrWhiteSpace($RunAsUser)) { "$env:COMPUTERNAME\robot" } else { $RunAsUser }
try {
  $account = New-Object System.Security.Principal.NTAccount($userId)
  $null = $account.Translate([System.Security.Principal.SecurityIdentifier])
} catch {
  throw "Не найдена учётная запись worker '$userId'. Создайте локального пользователя robot или задайте -RunAsUser."
}

$nodeVersion = & node --version
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) {
  throw "Для установки требуется Node.js 24+, найдено: $nodeVersion"
}

Set-Location $ProjectPath
$configurationFile = if ($EnvFile) {
  if ([IO.Path]::IsPathRooted($EnvFile)) {
    [IO.Path]::GetFullPath($EnvFile)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectPath $EnvFile))
  }
} else {
  Join-Path $ProjectPath '.env'
}
if (-not (Test-Path $configurationFile) -and -not $EnvFile) {
  Copy-Item 'windows\.env.example' '.env'
  throw 'Создан .env. Заполните секреты и повторите установку.'
}
if (-not (Test-Path $configurationFile)) {
  throw "Не найден файл конфигурации $configurationFile"
}

$preflight = Join-Path $ProjectPath 'windows\preflight.ps1'
& $preflight -ProjectPath $ProjectPath -EnvFile $configurationFile -Port $Port
if ($LASTEXITCODE -ne 0) { throw 'Windows preflight завершился с ошибкой' }

if (-not $SkipDependencyInstall) {
  $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
  # npm warnings on stderr must not terminate Windows PowerShell 5.1.
  # Merge streams in cmd itself; still reject a nonzero npm exit code below.
  & cmd.exe /d /c "npm.cmd ci --omit=dev 2>&1"
  if ($LASTEXITCODE -ne 0) { throw 'npm ci завершился с ошибкой' }
}

$powerShell = (Get-Command powershell.exe).Source
$startScript = Join-Path $ProjectPath 'windows\start-worker.ps1'
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ProjectPath `"$ProjectPath`" -EnvFile `"$configurationFile`" -RestartOnExit"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

try {
  if (-not (Get-NetFirewallRule -DisplayName 'Script Factory API' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Script Factory API' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  }
} catch {
  Write-Warning "Правило Firewall не создано. Выполните скрипт от администратора или откройте TCP $Port вручную."
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Задача $TaskName настроена для $userId; команда запуска отправлена. Пользователь должен войти в Windows. Проверка: http://localhost:$Port/health"
