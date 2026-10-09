param(
  [Parameter(Mandatory=$true)][string]$ProjectPath,
  [Parameter(Mandatory=$true)][string]$PackageZip,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [string]$EnvFile = '',
  [string]$TaskName = 'ScriptFactory-Test-UN',
  [string]$TaskPath = '\',
  [int]$Port = 33001,
  [string]$BackupRoot = 'C:\ScriptFactory-backups',
  [switch]$ConfirmNoNewJobs,
  [switch]$ConfirmReplaceCode
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $ConfirmNoNewJobs -or -not $ConfirmReplaceCode) {
  throw 'ConfirmNoNewJobs and ConfirmReplaceCode are required; pause 1C submissions and review local code changes first.'
}
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
$PackageZip = [IO.Path]::GetFullPath($PackageZip)
$configurationFile = if ($EnvFile) {
  if ([IO.Path]::IsPathRooted($EnvFile)) { [IO.Path]::GetFullPath($EnvFile) }
  else { [IO.Path]::GetFullPath((Join-Path $ProjectPath $EnvFile)) }
} else { Join-Path $ProjectPath '.env' }
function Read-Configuration([string]$file) {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    $t = $line.Trim()
    if ($t -and -not $t.StartsWith('#') -and $t.Contains('=')) {
      $index = $t.IndexOf('=')
      $values[$t.Substring(0,$index).Trim()] = $t.Substring($index+1).Trim().Trim('"').Trim("'")
    }
  }
  return $values
}
function In-Directory([string]$path,[string]$root) {
  return $path.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Read-Health { return Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5 }
function Wait-Ready([string]$version) {
  for ($i=0; $i -lt 30; $i++) {
    try {
      $h = Read-Health
      if ($h.status -eq 'ok' -and $h.ready -and $h.version -eq $version -and $h.un_id -eq $configuration['UN_ID']) { return $h }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "Worker did not become ready with version $version"
}
function Stop-ExactWorker {
  Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  Start-Sleep -Seconds 2
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$workerId" -ErrorAction SilentlyContinue
  if ($p) {
    if ($p.Name -ne 'node.exe' -or $p.CommandLine.IndexOf($configurationFile,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Worker PID changed; refusing to terminate unrelated process' }
    Stop-Process -Id $workerId -Force
  }
  for ($i=0; $i -lt 20; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Listener did not stop; no files will be replaced'
}
$configuration = Read-Configuration $configurationFile
if (-not $configuration['UN_ID']) { throw 'UN_ID is required' }
if (-not $configuration['API_KEY']) { throw 'API_KEY is required' }
if ([int]$configuration['PORT'] -ne $Port) { throw 'Port differs from configuration PORT' }
$dataPath = if ($configuration['DATA_DIR']) {
  if ([IO.Path]::IsPathRooted($configuration['DATA_DIR'])) { [IO.Path]::GetFullPath($configuration['DATA_DIR']) }
  else { [IO.Path]::GetFullPath((Join-Path $ProjectPath $configuration['DATA_DIR'])) }
} else { Join-Path $ProjectPath 'data' }
if ((In-Directory $BackupRoot $ProjectPath) -or (In-Directory $BackupRoot $dataPath)) { throw 'BackupRoot must be outside project and DATA_DIR' }
if ((Get-FileHash $PackageZip -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Archive checksum mismatch' }
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion.TrimStart('v').Split('.')[0] -lt 24) { throw 'Node.js 24+ is required' }
$before = Read-Health
if (-not $before.ready -or $before.un_id -ne $configuration['UN_ID']) { throw 'Current worker is not ready or has another UN_ID' }
if ($before.queue.running -ne 0 -or $before.queue.queued -ne 0) { throw 'Queue is not empty' }
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
$workerIds = @($listeners.OwningProcess | Select-Object -Unique)
if ($workerIds.Count -ne 1) { throw 'Ambiguous listener process' }
$workerId = $workerIds[0]
$worker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerId"
if ($worker.Name -ne 'node.exe' -or $worker.CommandLine.IndexOf($configurationFile,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Cannot confirm listener uses the supplied EnvFile' }
if (-not ($task.Actions.Arguments -join ' ').Contains($ProjectPath)) { throw 'Scheduled task does not reference supplied ProjectPath' }
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$stage = Join-Path $BackupRoot "stage-$stamp"
$backup = Join-Path $BackupRoot "backup-$stamp"
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($PackageZip)
try {
  foreach ($entry in $zip.Entries) {
    $rel = $entry.FullName.Replace('/','\')
    $destination = [IO.Path]::GetFullPath((Join-Path $app $rel))
    if (-not (In-Directory $destination $app)) { throw 'Unsafe archive path' }
    $first = $rel.Split('\')[0]
    if ($first -in @('.env','.git','node_modules','data','work','demo-data')) { throw 'Archive contains local state or secrets' }
  }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $PackageZip -DestinationPath $app
foreach ($file in @('package.json','package-lock.json','src\server.js','windows\start-worker.ps1')) {
  if (-not (Test-Path (Join-Path $app $file))) { throw "Missing release file $file; ZIP must have project files at its root" }
}
$package = Get-Content (Join-Path $app 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.version -ne $ExpectedVersion) { throw 'Package version differs from ExpectedVersion' }
& $node --check (Join-Path $app 'src\server.js')
if ($LASTEXITCODE -ne 0) { throw 'Staged server syntax check failed' }
# PowerShell 5.1 cannot reliably parse package-lock packages['']; use Node for hashing.
$fingerprintFile = Join-Path $stage 'dependency-fingerprint.mjs'
$fingerprintSource = @'
import fs from 'node:fs';
import crypto from 'node:crypto';
const v = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
delete v.version;
if (v.packages && v.packages['']) delete v.packages[''].version;
console.log(crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'));
'@
[IO.File]::WriteAllText($fingerprintFile,$fingerprintSource,(New-Object Text.UTF8Encoding($false)))
$oldFingerprint = & $node $fingerprintFile (Join-Path $ProjectPath 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read current dependency lock' }
$newFingerprint = & $node $fingerprintFile (Join-Path $app 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read release dependency lock' }
$changeDependencies = $oldFingerprint -ne $newFingerprint -or -not (Test-Path (Join-Path $ProjectPath 'node_modules'))
if ($changeDependencies) {
  $previousSkip = $env:PUPPETEER_SKIP_DOWNLOAD
  Push-Location $app
  try {
    $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
    & $npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Staged npm ci failed; current worker is unchanged' }
  } finally { Pop-Location; $env:PUPPETEER_SKIP_DOWNLOAD = $previousSkip }
}
$files = @(Get-ChildItem $app -Recurse -File | Where-Object { $_.FullName -notlike "$app\node_modules\*" } | ForEach-Object { $_.FullName.Substring(($app+'\').Length) })
# Refuse to overwrite protected state even when custom DATA_DIR/EnvFile is inside an archive directory.
foreach ($rel in $files) {
  $target = [IO.Path]::GetFullPath((Join-Path $ProjectPath $rel))
  if ($target.Equals($configurationFile,[StringComparison]::OrdinalIgnoreCase) -or (In-Directory $target $dataPath)) { throw 'Release file overlaps EnvFile or DATA_DIR' }
}
New-Item -ItemType Directory -Path (Join-Path $backup 'code') -Force | Out-Null
foreach ($rel in $files) {
  $source = Join-Path $ProjectPath $rel
  if (Test-Path $source) {
    $target = Join-Path "$backup\code" $rel
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
}
$manifest = @{ old_version=$before.version; new_version=$ExpectedVersion; project_path=$ProjectPath; env_file=$configurationFile; data_dir=$dataPath; task_name=$TaskName; task_path=$TaskPath; archive_sha256=$ExpectedSha256; dependencies_changed=$changeDependencies; files=$files }
[IO.File]::WriteAllText((Join-Path $backup 'manifest.json'),($manifest|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
$stopped = $false
$codeChanged = $false
$dependencyMoved = $false
try {
  $lastHealth = Read-Health
  if ($lastHealth.queue.running -ne 0 -or $lastHealth.queue.queued -ne 0) { throw 'Queue changed before stopping' }
  # Mark stop intent first so a partially stopped task is restarted on error.
  $stopped = $true
  Stop-ExactWorker
  Copy-Item -LiteralPath $configurationFile -Destination (Join-Path $backup 'saved.env')
  if (Test-Path $dataPath) { Copy-Item -LiteralPath $dataPath -Destination (Join-Path $backup 'data') -Recurse }
  $codeChanged = $true
  foreach ($rel in $files) {
    $target = Join-Path $ProjectPath $rel
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $app $rel) -Destination $target -Force
  }
  if ($changeDependencies) {
    if (Test-Path "$ProjectPath\node_modules") { Move-Item "$ProjectPath\node_modules" "$backup\node_modules" }
    $dependencyMoved = $true
    Move-Item "$app\node_modules" "$ProjectPath\node_modules"
  }
  Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  $after = Wait-Ready $ExpectedVersion
  if ($after.release_date -ne $package.releaseDate) { throw 'Release date differs from archive' }
  [pscustomobject]@{ updated=$true; version=$after.version; un_id=$after.un_id; ready=$after.ready; backup=$backup; dependencies_changed=$changeDependencies } | ConvertTo-Json -Depth 5
} catch {
  $failure = $_.Exception.Message
  if ($stopped) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    $newListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($id in @($newListener.OwningProcess | Select-Object -Unique)) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
      if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine.IndexOf($configurationFile,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Stop-Process -Id $id -Force }
      elseif ($p) { throw "Rollback blocked by unrelated listener; backup: $backup; original error: $failure" }
    }
    $rollbackListenerStopped = $false
    for ($i=0; $i -lt 20; $i++) {
      if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $rollbackListenerStopped = $true; break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $rollbackListenerStopped) { throw "Rollback listener did not stop; files are unchanged. Backup: $backup. Original error: $failure" }
    if ($codeChanged) {
      foreach ($rel in $files) {
        $old = Join-Path "$backup\code" $rel
        $target = Join-Path $ProjectPath $rel
        if (Test-Path $old) { Copy-Item -LiteralPath $old -Destination $target -Force }
        elseif (Test-Path $target) { Remove-Item -LiteralPath $target -Force }
      }
    }
    if ($dependencyMoved) {
      if (Test-Path "$ProjectPath\node_modules") { Move-Item "$ProjectPath\node_modules" "$stage\failed-node_modules" }
      if (Test-Path "$backup\node_modules") { Move-Item "$backup\node_modules" "$ProjectPath\node_modules" }
    }
    # DATA_DIR is deliberately not restored over any new jobs; see manual rollback instructions.
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    $rollback = Wait-Ready $before.version
    throw "Update failed; old version $($rollback.version) is ready. Backup: $backup. Error: $failure"
  }
  throw
}
