param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvFile = ''
)

$ErrorActionPreference = 'Stop'
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

if (-not $env:PUPPETEER_EXECUTABLE_PATH) {
  $candidates = @(
    (Read-DotEnvValue $configurationFile 'PUPPETEER_EXECUTABLE_PATH'),
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
    "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
    "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe"
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $browser) {
    throw 'Яндекс Браузер не найден. Укажите PUPPETEER_EXECUTABLE_PATH в файле конфигурации.'
  }
  $env:PUPPETEER_EXECUTABLE_PATH = $browser
}

& node "--env-file-if-exists=$configurationFile" 'src/server.js'
exit $LASTEXITCODE
