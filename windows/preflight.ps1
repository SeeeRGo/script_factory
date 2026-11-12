param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvFile = '',
  [int]$Port = 33001,
  [switch]$ExpectServiceRunning
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Read-DotEnv([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
    $values[$name] = $value
  }
  return $values
}

function Resolve-ProjectPath([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
  return [IO.Path]::GetFullPath((Join-Path $ProjectPath $Value))
}

$configurationFile = if ($EnvFile) {
  if ([IO.Path]::IsPathRooted($EnvFile)) {
    [IO.Path]::GetFullPath($EnvFile)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectPath $EnvFile))
  }
} else {
  Join-Path $ProjectPath '.env'
}
$configuration = Read-DotEnv $configurationFile
if (-not (Test-Path $configurationFile)) {
  $errors.Add("Не найден $configurationFile")
}

$nodeVersion = $null
try {
  $nodeVersion = (& node --version).Trim()
  if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) {
    $errors.Add("Нужен Node.js 24+, найден $nodeVersion")
  }
} catch {
  $errors.Add('Node.js не найден в PATH')
}

foreach ($secretName in @('API_KEY', 'WEB_PASSWORD')) {
  $value = $configuration[$secretName]
  if (-not $value -or $value -match 'replace|change-this') {
    $errors.Add("Заполните $secretName в .env")
  }
}
if([bool]$configuration['CALLBACK_AUTH_USERNAME'] -ne [bool]$configuration['CALLBACK_AUTH_PASSWORD']){$errors.Add('Для Basic callback нужны CALLBACK_AUTH_USERNAME и CALLBACK_AUTH_PASSWORD')}
if (-not $configuration['UN_ID']) { $errors.Add('Заполните UN_ID в .env') }

$browserOptionsText = if ($env:BROWSER_OPTIONS_JSON) { $env:BROWSER_OPTIONS_JSON } else { $configuration['BROWSER_OPTIONS_JSON'] }
$browserOptions = $null
if ($browserOptionsText) {
  try {
    $browserOptions = $browserOptionsText | ConvertFrom-Json
    if ($browserOptions -isnot [PSCustomObject]) { throw 'Expected object' }
  } catch { $errors.Add('BROWSER_OPTIONS_JSON должен содержать корректный JSON-объект') }
}
$explicitBrowser = if ($browserOptions -and $browserOptions.executable_path) {
  $browserOptions.executable_path
} elseif ($env:PUPPETEER_EXECUTABLE_PATH) {
  $env:PUPPETEER_EXECUTABLE_PATH
} else {
  $configuration['PUPPETEER_EXECUTABLE_PATH']
}
$browserPath = $null
if ($explicitBrowser) {
  if (Test-Path -LiteralPath $explicitBrowser -PathType Leaf) { $browserPath = $explicitBrowser }
} else {
  $browserCandidates = @(
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
    "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
    "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $browserPath = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $browserPath) { $errors.Add('Браузер недоступен; задайте executable_path в BROWSER_OPTIONS_JSON или PUPPETEER_EXECUTABLE_PATH') }

$allowedRoots = @($configuration['FILESYSTEM_ALLOWED_ROOTS'] -split ';' | Where-Object { $_ })
if ($allowedRoots.Count -eq 0) {
  $errors.Add('FILESYSTEM_ALLOWED_ROOTS должен содержать хотя бы один каталог')
}
$resolvedRoots = @()
foreach ($root in $allowedRoots) {
  try {
    $resolved = Resolve-ProjectPath $root.Trim()
    New-Item -ItemType Directory -Force -Path $resolved | Out-Null
    $probe = Join-Path $resolved ('.script-factory-preflight-' + [guid]::NewGuid().ToString('N'))
    Set-Content -Path $probe -Value 'ok' -Encoding UTF8
    Remove-Item -LiteralPath $probe -Force
    $resolvedRoots += $resolved
  } catch {
    $errors.Add("Нет доступа на запись к файловому корню ${root}: $($_.Exception.Message)")
  }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($ExpectServiceRunning) {
  if (-not $listener) { $errors.Add("Сервис не слушает TCP $Port") }
} elseif ($listener) {
  $warnings.Add("TCP $Port уже занят процессом PID $($listener.OwningProcess -join ', ')")
}

$health = $null
if ($ExpectServiceRunning -and $listener) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if ($health.status -ne 'ok') { $errors.Add('Healthcheck не вернул status=ok') }
    if ($health.ready -ne $true) {
      $message = if ($health.error.message) { ": $($health.error.message)" } else { '' }
      $errors.Add("Healthcheck не вернул ready=true$message")
    }
    if ($configuration['UN_ID'] -and $health.un_id -ne $configuration['UN_ID']) {
      $errors.Add("Healthcheck вернул другую УН: $($health.un_id)")
    }
  } catch {
    $errors.Add("Healthcheck недоступен: $($_.Exception.Message)")
  }
}

$callbackOrigins = @($configuration['CALLBACK_ALLOWED_ORIGINS'] -split ',' | Where-Object { $_ })
foreach ($origin in $callbackOrigins) {
  try {
    $callbackUri = [Uri]::new($origin.Trim())
    if ($callbackUri.Scheme -notin @('http', 'https')) { throw 'Допустимы только http и https' }
  } catch {
    $errors.Add("Некорректный CALLBACK_ALLOWED_ORIGINS: $origin")
  }
}

$report = [ordered]@{
  ok = $errors.Count -eq 0
  checked_at = (Get-Date).ToString('o')
  project_path = $ProjectPath
  env_file = $configurationFile
  node_version = $nodeVersion
  yandex_browser = $browserPath
  port = $Port
  filesystem_roots = $resolvedRoots
  health = $health
  warnings = @($warnings)
  errors = @($errors)
}
$report | ConvertTo-Json -Depth 8
if ($errors.Count -gt 0) { exit 1 }
