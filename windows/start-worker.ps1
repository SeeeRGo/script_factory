param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-Location $ProjectPath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 24+ не найден в PATH'
}

if (-not $env:PUPPETEER_EXECUTABLE_PATH) {
  $candidates = @(
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
    "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
    "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe"
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $browser) {
    throw 'Яндекс Браузер не найден. Укажите PUPPETEER_EXECUTABLE_PATH в системных переменных.'
  }
  $env:PUPPETEER_EXECUTABLE_PATH = $browser
}

New-Item -ItemType Directory -Force -Path '.\data', '.\work\incoming', '.\work\outgoing', '.\work\archive' | Out-Null
node --env-file-if-exists=.env src/server.js
