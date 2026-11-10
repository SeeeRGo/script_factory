param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvFile = '',
  [switch]$RestartOnExit,
  [switch]$ApiOnly
)

$ErrorActionPreference = 'Stop'
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
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

function Read-DotEnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }
    if ($trimmed.Substring(0, $separator).Trim() -eq $Name) {
      return $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 24+ не найден в PATH'
}

if (-not (Test-Path $configurationFile)) {
  throw "Не найден файл конфигурации $configurationFile"
}

if (-not $ApiOnly) {
$browserOptionsText = if ($env:BROWSER_OPTIONS_JSON) { $env:BROWSER_OPTIONS_JSON } else { Read-DotEnvValue $configurationFile 'BROWSER_OPTIONS_JSON' }
$browserOptions = $null
if ($browserOptionsText) {
  try {
    $browserOptions = $browserOptionsText | ConvertFrom-Json
    if ($browserOptions -isnot [PSCustomObject]) { throw 'Expected object' }
  } catch { throw 'BROWSER_OPTIONS_JSON должен содержать корректный JSON-объект' }
}
$explicitBrowser = if ($browserOptions -and $browserOptions.executable_path) {
  $browserOptions.executable_path
} elseif ($env:PUPPETEER_EXECUTABLE_PATH) {
  $env:PUPPETEER_EXECUTABLE_PATH
} else {
  Read-DotEnvValue $configurationFile 'PUPPETEER_EXECUTABLE_PATH'
}
if ($explicitBrowser) {
  if (-not (Test-Path -LiteralPath $explicitBrowser -PathType Leaf)) { throw 'Заданный браузер недоступен; проверьте executable_path в конфигурации УН' }
  $env:PUPPETEER_EXECUTABLE_PATH = $explicitBrowser
} else {
  $candidates = @(
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
    "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
    "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $browser = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $browser) { throw 'Браузер не найден. Укажите executable_path в BROWSER_OPTIONS_JSON или PUPPETEER_EXECUTABLE_PATH.' }
  $env:PUPPETEER_EXECUTABLE_PATH = $browser
}

}
$mode = Read-DotEnvValue $configurationFile 'EXECUTION_MODE'
$entryPoint = if ($ApiOnly -or $mode -ne 'broker') { Join-Path $ProjectPath 'src\server.js' } else { Join-Path $ProjectPath 'src\browser-worker.js' }
$role = if ($ApiOnly) { 'Api' } else { 'Worker' }
if (-not $ApiOnly) { $env:WORKER_SESSION_ID = [string](Get-Process -Id $PID).SessionId }
if (-not $RestartOnExit) {
  & node "--env-file=$configurationFile" $entryPoint
  exit $LASTEXITCODE
}

# One supervisor per configuration, including across Windows sessions.
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($configurationFile.ToLowerInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = New-Object Threading.Mutex($false, "Global\ScriptFactory-$role-$key")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'A supervisor already owns this configuration' }
  $dataPath = Read-DotEnvValue $configurationFile 'DATA_DIR'
  if (-not $dataPath) { $dataPath = Join-Path $ProjectPath 'data' }
  if (-not [IO.Path]::IsPathRooted($dataPath)) { $dataPath = Join-Path $ProjectPath $dataPath }
  $logPath = Join-Path $dataPath ($role.ToLowerInvariant()+'-logs')
  New-Item -ItemType Directory -Path $logPath -Force | Out-Null
  $sessionId = (Get-Process -Id $PID).SessionId
  if (-not $ApiOnly -and $sessionId -eq 0) { throw 'Worker requires an interactive user session, not Session 0' }
  function Write-SupervisorLog([string]$Message) {
    $file = Join-Path $logPath 'supervisor.log'
    if ((Test-Path $file) -and (Get-Item $file).Length -gt 1MB) { Move-Item $file "$file.previous" -Force }
    Add-Content -LiteralPath $file -Encoding UTF8 -Value "$(Get-Date -Format o) supervisor=$PID session=$sessionId $Message"
  }
  # Live workers are never restarted on a slow/unready health response.
  $envPattern = '--env-file(?:-if-exists)?=' + [regex]::Escape($configurationFile) + '(?=["\s]|$)'
  $serverPattern = [regex]::Escape($entryPoint) + '(?=["\s]|$)'
  $node = (Get-Command node -ErrorAction Stop).Source
  if (-not ('ScriptFactory.WorkerJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'worker-job.cs') }
  Write-SupervisorLog 'started; restart delay=10s'
  while ($true) {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -imatch $envPattern -and ($_.CommandLine -imatch $serverPattern)
    })
    if ($existing.Count -gt 0) { Start-Sleep -Seconds 5; continue }
    # Keep stdout/stderr from the latest 20 launches.
    Get-ChildItem $logPath -Filter 'worker-*.log' -File | Sort-Object Name -Descending | Select-Object -Skip 38 | Remove-Item -Force
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + "-$PID"
    $worker = $null
    $job = New-Object ScriptFactory.WorkerJob
    try {
      $worker = Start-Process -FilePath $node -ArgumentList @("`"--env-file=$configurationFile`"", "`"$entryPoint`"") -WorkingDirectory $ProjectPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logPath "worker-$stamp-out.log") -RedirectStandardError (Join-Path $logPath "worker-$stamp-err.log")
      try { $job.Assign($worker) }
      catch {
        if (-not $worker.HasExited) { Stop-Process -Id $worker.Id -Force }
        throw
      }
      Write-SupervisorLog "worker started pid=$($worker.Id)"
      $null = $worker.Handle
      $worker.WaitForExit()
      Write-SupervisorLog "worker exited pid=$($worker.Id) code=$($worker.ExitCode); retry in 10s"
    } catch {
      Write-SupervisorLog 'worker launch/wait failed; retry in 10s (see worker logs)'
      if ($worker -and -not $worker.HasExited) { throw }
    } finally {
      $job.Dispose()
      if ($worker) { $worker.Dispose() }
    }
    Start-Sleep -Seconds 10
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
