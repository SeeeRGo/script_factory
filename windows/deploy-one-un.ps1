param(
  [Parameter(Mandatory=$true)][string]$PackageZip,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [string]$ProjectPath='C:\script_factory',
  [string]$EnvFile='',
  [string]$BackupRoot='C:\ScriptFactory-backups',
  [string]$TaskName='ScriptFactory-Test-UN',
  [string]$TaskPath='\',
  [string]$RunAsUser='',
  [int]$Port=33001,
  [switch]$ConfirmNoNewJobs,
  [switch]$ConfirmReplaceCode
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'deployment-state.ps1')
if(-not $ConfirmNoNewJobs -or -not $ConfirmReplaceCode){throw 'Pause 1C submissions and supply ConfirmNoNewJobs and ConfirmReplaceCode'}
$ProjectPath=[IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$BackupRoot=[IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
$PackageZip=[IO.Path]::GetFullPath($PackageZip)
# Never recursively replace a drive root or system/user directory.
$protected=@([IO.Path]::GetPathRoot($ProjectPath).TrimEnd('\'),$env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)},$env:ProgramData,(Join-Path $env:SystemDrive 'Users'))
foreach($p in $protected){if($p -and ($ProjectPath.Equals($p.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase) -or (Test-SFInside $ProjectPath $env:SystemRoot))){throw 'Unsafe ProjectPath'}}
if((Test-SFInside $BackupRoot $ProjectPath) -or (Test-SFInside $ProjectPath $BackupRoot)){throw 'BackupRoot and ProjectPath must be separate directories'}
if((Get-FileHash -LiteralPath $PackageZip -Algorithm SHA256).Hash -ne $ExpectedSha256){throw 'Archive checksum mismatch'}
$state=Get-SFInstallationState $ProjectPath
Write-Host "Node=$env:COMPUTERNAME Path=$ProjectPath State=$($state.state) Reasons=$($state.reasons -join '; ')"
New-Item -ItemType Directory -Path $BackupRoot -Force|Out-Null
& icacls.exe $BackupRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'|Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect backup directory'}
$stamp=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N')
$stage=Join-Path $BackupRoot "deploy-$stamp";$app=Join-Path $stage 'app'
New-Item -ItemType Directory -Path $app -Force|Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($PackageZip)
try{
 foreach($entry in $zip.Entries){
  $rel=$entry.FullName.Replace('/','\');$dest=[IO.Path]::GetFullPath((Join-Path $app $rel))
  if([IO.Path]::IsPathRooted($rel) -or $rel.Contains(':') -or -not(Test-SFInside $dest $app)){throw 'Unsafe archive path'}
  if($rel.Split('\')[0] -in @('.env','.git','node_modules','data','work','demo-data')){throw 'Archive contains local state or secrets'}
 }
}finally{$zip.Dispose()}
Expand-Archive -LiteralPath $PackageZip -DestinationPath $app
foreach($rel in @('package.json','package-lock.json','src\server.js','windows\install-task.ps1','docs\project-guide\tools\update-one-un.ps1')){
 if(-not(Test-Path -LiteralPath (Join-Path $app $rel) -PathType Leaf)){throw "Release missing $rel"}
}
$package=Get-Content (Join-Path $app 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($package.name -ne 'script-factory' -or $package.version -ne $ExpectedVersion){throw 'Unexpected release metadata'}
$existingEnv=Join-Path $ProjectPath '.env'
# Existing configuration wins; incoming per-node env is for a new/missing configuration.
$sourceEnv=if(Test-Path -LiteralPath $existingEnv -PathType Leaf){$existingEnv}elseif($EnvFile){[IO.Path]::GetFullPath($EnvFile)}else{throw 'EnvFile is required for a new installation'}
$config=Read-SFEnvironment $sourceEnv
foreach($key in @('UN_ID','API_KEY','WEB_PASSWORD')){if(-not $config[$key]){throw "Configuration missing $key; correct the saved env before retrying"}}
if([int]$config['PORT'] -ne $Port){throw 'Port differs from configuration PORT'}
if($state.state -eq 'update'){
 # Do not call a stopped API or a missing RDP session a broken installation.
 $task=Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
 $workerTaskOk=$true
 if($config['EXECUTION_MODE'] -eq 'broker'){
  $expectedWorker=if($config['WORKER_TASK_NAME']){$config['WORKER_TASK_NAME']}else{$TaskName+'-Worker'}
  $workerTask=Get-ScheduledTask -TaskName $expectedWorker -TaskPath $TaskPath -ErrorAction SilentlyContinue
  $workerTaskOk=$workerTask -and ($workerTask.Actions.Arguments -join ' ').Contains($ProjectPath)
 }
 if($task -and ($task.Actions.Arguments -join ' ').Contains($ProjectPath) -and $workerTaskOk){
  & (Join-Path $app 'docs\project-guide\tools\update-one-un.ps1') -ProjectPath $ProjectPath -PackageZip $PackageZip -ExpectedVersion $ExpectedVersion -ExpectedSha256 $ExpectedSha256 -TaskName $TaskName -TaskPath $TaskPath -Port $Port -BackupRoot $BackupRoot -ConfirmNoNewJobs -ConfirmReplaceCode
  return
 }
 Write-Host 'Task missing or invalid; reinstalling task and application with preserved state.'
}
$dataPath=if($config['DATA_DIR']){$config['DATA_DIR']}else{'data'}
if(-not [IO.Path]::IsPathRooted($dataPath)){$dataPath=Join-Path $ProjectPath $dataPath}
$dataPath=[IO.Path]::GetFullPath($dataPath)
if((Test-SFInside $ProjectPath $dataPath) -or (Test-SFInside $BackupRoot $dataPath)){throw 'DATA_DIR overlaps project root or backup directory'}
# Reparse points can lead outside the installation. Do not move/delete through them.
if(Test-Path -LiteralPath $ProjectPath){
 $links=@(Get-Item -LiteralPath $ProjectPath;Get-ChildItem -LiteralPath $ProjectPath -Force -Recurse)|Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}
 if($links){throw 'Installation contains reparse points; manual inspection is required'}
}
Copy-Item -LiteralPath $sourceEnv -Destination (Join-Path $stage 'saved.env')
# Prepare dependencies before stopping anything; current installation remains intact on npm failure.
$previousSkip=$env:PUPPETEER_SKIP_DOWNLOAD
Push-Location $app
try{
 $env:PUPPETEER_SKIP_DOWNLOAD='true'
 & cmd.exe /d /c 'npm.cmd ci --omit=dev 2>&1'
 if($LASTEXITCODE -ne 0){throw 'Staged npm ci failed; installation unchanged'}
}finally{Pop-Location;$env:PUPPETEER_SKIP_DOWNLOAD=$previousSkip}
$workerName=if($config['WORKER_TASK_NAME']){$config['WORKER_TASK_NAME']}else{$TaskName+'-Worker'}
$tasks=@();foreach($name in @($TaskName,$workerName)|Select-Object -Unique){
 $t=Get-ScheduledTask -TaskName $name -TaskPath $TaskPath -ErrorAction SilentlyContinue
 if($t){
  if(-not ($t.Actions.Arguments -join ' ').Contains($ProjectPath)){throw "Task $name belongs to another installation"}
  $tasks+=@{name=$name;xml=(Export-ScheduledTask -TaskName $name -TaskPath $TaskPath);enabled=[bool]$t.Settings.Enabled}
 }
}
# A healthy endpoint with pending work must never be replaced, even with broken files.
try{$health=Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5}catch{$health=$null}
if($health -and ($health.queue.running -gt 0 -or $health.queue.queued -gt 0)){throw 'Queue is not empty'}
# Do not kill a browser or a running application to repair files. Stop only our supervisors;
# refuse if any remaining process still references this project, including a listener.
$backup=Join-Path $BackupRoot "replaced-$stamp";$moved=$false;$installed=$false
try{
 foreach($t in $tasks){Disable-ScheduledTask -TaskName $t.name -TaskPath $TaskPath|Out-Null;Stop-ScheduledTask -TaskName $t.name -TaskPath $TaskPath}
 Start-Sleep -Seconds 2
 $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($ProjectPath,[StringComparison]::OrdinalIgnoreCase) -ge 0})
 if($processes.Count){throw 'Project processes are still running; no files replaced. Drain/stop them and retry.'}
 if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'API port is occupied; no files replaced'}
 # Read the durable queue after stopping supervisors, including when HTTP was unavailable.
 $database=Join-Path $dataPath 'state.sqlite'
 if(Test-Path -LiteralPath $database){
  $queueCheck=Join-Path $stage 'check-queue.mjs'
  [IO.File]::WriteAllText($queueCheck,@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  for (const row of db.prepare('SELECT snapshot_json FROM jobs').iterate()) {
    const job = JSON.parse(row.snapshot_json);
    if (['queued', 'running', 'retrying'].includes(job.status) || job.worker_unconfirmed) {
      throw new Error('Unfinished jobs exist; repair refused');
    }
  }
} finally { db.close(); }
'@,(New-Object Text.UTF8Encoding($false)))
  & node --no-warnings $queueCheck $database
  if($LASTEXITCODE -ne 0){throw 'Cannot confirm an empty durable queue; files unchanged'}
 }

 if(Test-Path -LiteralPath $ProjectPath){Move-Item -LiteralPath $ProjectPath -Destination $backup;$moved=$true}
 Move-Item -LiteralPath $app -Destination $ProjectPath;$installed=$true
 [IO.File]::WriteAllText((Join-Path $ProjectPath '.sf-deploy-incomplete'),$stamp)
 Copy-Item -LiteralPath (Join-Path $stage 'saved.env') -Destination (Join-Path $ProjectPath '.env') -Force
 if($moved -and (Test-SFInside $dataPath $ProjectPath)){
  $rel=$dataPath.Substring($ProjectPath.Length).TrimStart('\');$oldData=Join-Path $backup $rel
  if(Test-Path -LiteralPath $oldData){
   if(Test-Path -LiteralPath $dataPath){throw 'Release overlaps saved DATA_DIR'}
   New-Item -ItemType Directory -Path (Split-Path $dataPath) -Force|Out-Null
   Copy-Item -LiteralPath $oldData -Destination $dataPath -Recurse
  }
 }
 $user=if($RunAsUser){$RunAsUser}elseif($config['WORKER_ACCOUNT']){$config['WORKER_ACCOUNT']}else{"$env:COMPUTERNAME\robot"}
 # Staging inherits the admin-only backup ACL. Grant the interactive worker read
 # access to application code before installing tasks; install-task protects env/data.
 $userSid=(New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier])
 $codeAcl=New-Object Security.AccessControl.DirectorySecurity
 $codeAcl.SetAccessRuleProtection($true,$false)
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){
  $identity=New-Object Security.Principal.SecurityIdentifier($sid)
  $codeAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 }
 $codeAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
 Set-Acl -LiteralPath $ProjectPath -AclObject $codeAcl
 & (Join-Path $ProjectPath 'windows\install-task.ps1') -ProjectPath $ProjectPath -TaskName $TaskName -TaskPath $TaskPath -RunAsUser $user -Port $Port -SkipDependencyInstall
 $live=$null
 for($i=0;$i -lt 30;$i++){
  try{$live=Invoke-RestMethod "http://127.0.0.1:$Port/live" -TimeoutSec 2;if($live.version -eq $ExpectedVersion -and $live.un_id -eq $config['UN_ID']){break}}catch{}
  Start-Sleep -Seconds 2
 }
 if(-not $live -or $live.version -ne $ExpectedVersion -or $live.un_id -ne $config['UN_ID']){throw 'Installed API did not pass /live check'}
 Remove-Item -LiteralPath (Join-Path $ProjectPath '.sf-deploy-incomplete')
 [pscustomobject]@{status='installed';previous_state=$state.state;version=$live.version;un_id=$live.un_id;backup=$backup}
}catch{
 $failure=$_.Exception.Message
 # Preserve both trees on failure. Never overwrite data produced by the failed start.
 if($installed){
  foreach($name in @($TaskName,$workerName)|Select-Object -Unique){if(Get-ScheduledTask -TaskName $name -TaskPath $TaskPath -ErrorAction SilentlyContinue){Disable-ScheduledTask -TaskName $name -TaskPath $TaskPath|Out-Null;Stop-ScheduledTask -TaskName $name -TaskPath $TaskPath}}
  throw "Reinstallation failed: $failure. Previous tree: $backup. New tree and data retained at $ProjectPath; tasks disabled. Inspect before retrying."
 }
 if($moved){Move-Item -LiteralPath $backup -Destination $ProjectPath}
 foreach($t in $tasks){if($t.enabled){Enable-ScheduledTask -TaskName $t.name -TaskPath $TaskPath|Out-Null;Start-ScheduledTask -TaskName $t.name -TaskPath $TaskPath}}
 throw
}
