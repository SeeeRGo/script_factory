param(
  [string]$ExecutablePath = "${env:ProgramFiles(x86)}\Tensor\Saby\saby.exe",
  [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'ScriptFactory\logs'),
  [int]$CheckIntervalSeconds = 5,
  [int]$RestartDelaySeconds = 15
)

$ErrorActionPreference = 'Stop'
$ExecutablePath = [IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw "Saby executable not found: $ExecutablePath" }
$sessionId = (Get-Process -Id $PID).SessionId
if ($sessionId -eq 0) { throw 'Saby requires an interactive user session, not Session 0' }
if ($CheckIntervalSeconds -lt 1 -or $RestartDelaySeconds -lt 1) { throw 'Intervals must be positive' }
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
function Write-SabyLog([string]$Message) {
  $file = Join-Path $LogDirectory 'saby-supervisor.log'
  if ((Test-Path $file) -and (Get-Item $file).Length -gt 1MB) { Move-Item $file "$file.previous" -Force }
  Add-Content -LiteralPath $file -Encoding UTF8 -Value "$(Get-Date -Format o) supervisor=$PID session=$sessionId $Message"
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object Threading.Mutex($false, "Global\ScriptFactory-Saby-$sid-$sessionId")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Saby supervisor already owns this user session' }
  Write-SabyLog 'started'
  while ($true) {
    try {
      $existing = @(Get-CimInstance Win32_Process -Filter "Name='saby.exe'" | Where-Object {
        $_.SessionId -eq $sessionId -and $_.ExecutablePath -ieq $ExecutablePath
      })
      if ($existing.Count -eq 0) {
        $app = Start-Process -FilePath $ExecutablePath -WorkingDirectory (Split-Path -Parent $ExecutablePath) -WindowStyle Minimized -PassThru
        Write-SabyLog "Saby started pid=$($app.Id)"
        $app.Dispose()
        Start-Sleep -Seconds $RestartDelaySeconds
      } else {
        Start-Sleep -Seconds $CheckIntervalSeconds
      }
    } catch {
      Write-SabyLog 'Saby check/start failed; will retry'
      Start-Sleep -Seconds $RestartDelaySeconds
    }
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
