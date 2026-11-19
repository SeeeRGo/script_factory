param(
 [string]$SourceRoot=(Split-Path -Parent $PSScriptRoot),
 [string]$InstallDir='C:\ProgramData\ScriptFactoryAgent',
 [string]$ConfigFile='', [string]$ReleasePublicKey='',
 [string]$ProjectPath='', [string]$EnvFile='',
 [string]$TaskName='ScriptFactory-Fleet-Agent',
 [switch]$Defer, [switch]$Scheduled,
 [ValidateRange(10,86400)][int]$WaitSeconds=600,
 [ValidateRange(10,600)][int]$ContactSeconds=120
)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as administrator'}
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$installedConfig=Join-Path $InstallDir 'agent.config.json'
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if(-not $task -and -not $ConfigFile){
 if(Test-Path $InstallDir){throw 'Orphan agent directory: inspect registration before installation'}
 Write-Host 'Fleet agent not configured. Supply FleetConfigFile and ReleasePublicKey to enroll this UN.'
 return
}
# Existing credentials and settings always win. Never silently rotate an identity.
$configPath=if($task){$installedConfig}else{$ConfigFile}
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
if($task){
 $account=$task.Principal.UserId;$systemAccount=$account -in @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')
 if(-not $systemAccount){try{$systemAccount=((New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18')}catch{}}
 if(-not $systemAccount){throw 'Existing task is not the expected SYSTEM agent'}
}
if($config.node_id -notmatch '^[A-Za-z0-9_-]{1,100}$' -or -not $config.un_id -or $config.token.Length -lt 32 -or $config.token.StartsWith('REPLACE_')){throw 'Invalid agent enrollment identity/token'}
if(-not(Test-Path -LiteralPath $config.env_file -PathType Leaf)){throw 'Agent env_file not found'}
$unLine=Get-Content -LiteralPath $config.env_file -Encoding UTF8|Where-Object {$_ -match '^\s*UN_ID\s*='}|Select-Object -Last 1
$actualUn=if($unLine){($unLine -split '=',2)[1].Trim().Trim('"').Trim("'")}else{''}
if($actualUn -cne $config.un_id){throw 'Agent UN_ID differs from local API environment'}
if($task -and $ConfigFile){
 $desired=Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($key in @('node_id','un_id','central_url','token')){if($desired.$key -cne $config.$key){throw 'Enrollment differs from installed identity; use explicit RecoverExisting workflow'}}
}
if($ProjectPath -and [IO.Path]::GetFullPath($config.project_path).TrimEnd('\') -ine [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')){throw 'Agent project_path differs from API installation'}
if($EnvFile -and [IO.Path]::GetFullPath($config.env_file) -ine [IO.Path]::GetFullPath($EnvFile)){throw 'Agent env_file differs from API installation'}
$keyPath=if($task){Join-Path $InstallDir 'release-public.pem'}else{$ReleasePublicKey}
if(-not $keyPath -or -not(Test-Path -LiteralPath $keyPath -PathType Leaf)){throw 'Pinned release public key not found'}
$runtime=@('agent.mjs','common.mjs','configuration.mjs','config-local.mjs','config-update.ps1','windows-adapter.mjs','run-update.ps1','rollback-update.ps1','agent-host.ps1','worker-job.cs','update-one-un.ps1')
function Source-File([string]$name){
 if($name -eq 'agent-host.ps1'){return Join-Path $SourceRoot 'windows\fleet-agent-host.ps1'}
 if($name -eq 'worker-job.cs'){return Join-Path $SourceRoot 'windows\worker-job.cs'}
 if($name -eq 'update-one-un.ps1'){return Join-Path $SourceRoot 'docs\project-guide\tools\update-one-un.ps1'}
 return Join-Path $SourceRoot ('fleet\'+$name)
}
foreach($name in $runtime){if(-not(Test-Path -LiteralPath (Source-File $name))){throw "Agent source missing: $name"}}
foreach($relative in @('package.json','windows\install-fleet-agent.ps1')){if(-not(Test-Path (Join-Path $SourceRoot $relative))){throw "Agent source missing: $relative"}}
$version=(Get-Content (Join-Path $SourceRoot 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid source version'}
$descriptor=Join-Path $InstallDir 'agent-source.json'
$previousVersion=if(Test-Path $descriptor){(Get-Content $descriptor -Raw|ConvertFrom-Json).version}else{''}
if($previousVersion -and [version]$version -lt [version]$previousVersion){throw 'Agent downgrade refused'}
$changed=-not $task -or $previousVersion -ne $version
$previousResult=Join-Path $InstallDir 'agent-sync-result.json'
if(Test-Path $previousResult){$lastSync=Get-Content $previousResult -Raw|ConvertFrom-Json;if($lastSync.status -eq 'failed'){$changed=$true}}
foreach($name in $runtime){if(-not(Test-Path (Join-Path $InstallDir $name)) -or (Get-FileHash (Source-File $name)).Hash -ne (Get-FileHash (Join-Path $InstallDir $name)).Hash){$changed=$true}}
if(-not $changed){Write-Host "Fleet agent is current: $version";return}
if($task -and $task.State -eq 'Disabled'){throw 'Agent intentionally disabled; refusing automatic changes'}
function Protect-Directory([string]$directory){
 New-Item -ItemType Directory -Path $directory -Force|Out-Null
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){$identity=New-Object Security.Principal.SecurityIdentifier($sid);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 Set-Acl -LiteralPath $directory -AclObject $acl
}
if($Defer){
 $syncName=''
 foreach($pending in @(Get-ScheduledTask -TaskName 'ScriptFactory-AgentSync-*' -ErrorAction SilentlyContinue)){
  foreach($action in $pending.Actions){
   if($action.Arguments -match '-File "([^"\r\n]+)"'){
    $pendingRoot=Split-Path $matches[1] -Parent;$requestPath=Join-Path $pendingRoot 'request.json'
    if(Test-Path $requestPath){$request=Get-Content $requestPath -Raw|ConvertFrom-Json;$packagePath=Join-Path $pendingRoot 'package.json';if($request.InstallDir -ieq $InstallDir -and (Test-Path $packagePath) -and (Get-Content $packagePath -Raw|ConvertFrom-Json).version -eq $version){Write-Host "Fleet agent synchronization already scheduled: $version";return}}
   }
  }
 }
 # Task Scheduler creates an independent process, outside the agent's kill-on-close job.
 $stage=Join-Path $env:ProgramData ('ScriptFactoryAgentSync-'+[Guid]::NewGuid().ToString('N'))
 Protect-Directory $stage
 try{
  foreach($relative in @('package.json','windows\sync-installed-fleet-agent.ps1','windows\install-fleet-agent.ps1','windows\fleet-agent-host.ps1','windows\worker-job.cs','docs\project-guide\tools\update-one-un.ps1')+@($runtime|Where-Object {$_ -notin @('agent-host.ps1','worker-job.cs','update-one-un.ps1')}|ForEach-Object {'fleet\'+$_})){
   $destination=Join-Path $stage $relative;New-Item -ItemType Directory -Path (Split-Path $destination) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $SourceRoot $relative) -Destination $destination
  }
  # Paths/settings only; no secret is passed on a command line.
  $request=@{SourceRoot=$stage;InstallDir=$InstallDir;TaskName=$TaskName;ProjectPath=$ProjectPath;EnvFile=$EnvFile;WaitSeconds=$WaitSeconds;ContactSeconds=$ContactSeconds;Scheduled=$true}
  if(-not $task){Copy-Item -LiteralPath $configPath -Destination (Join-Path $stage 'enrollment.json');Copy-Item -LiteralPath $keyPath -Destination (Join-Path $stage 'release-public.pem');$request.ConfigFile=Join-Path $stage 'enrollment.json';$request.ReleasePublicKey=Join-Path $stage 'release-public.pem'}
  [IO.File]::WriteAllText((Join-Path $stage 'request.json'),($request|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  $launcher=Join-Path $stage 'launch.ps1'
  [IO.File]::WriteAllText($launcher,'$ErrorActionPreference="Stop"; try{$r=Get-Content (Join-Path $PSScriptRoot "request.json") -Raw|ConvertFrom-Json; $a=@{}; foreach($p in $r.PSObject.Properties){$a[$p.Name]=$p.Value}; & (Join-Path $PSScriptRoot "windows\sync-installed-fleet-agent.ps1") @a}finally{Unregister-ScheduledTask -TaskName ("ScriptFactory-AgentSync-"+(Split-Path $PSScriptRoot -Leaf)) -Confirm:$false -ErrorAction SilentlyContinue}',(New-Object Text.UTF8Encoding($false)))
  $syncName='ScriptFactory-AgentSync-'+(Split-Path $stage -Leaf)
  $action=New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcher+'"') -WorkingDirectory $stage
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
  $system=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($WaitSeconds+$ContactSeconds+180)) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $syncName -Action $action -Trigger $trigger -Principal $system -Settings $settings -Force|Out-Null
  if($task){[IO.File]::WriteAllText((Join-Path $InstallDir 'agent-sync-result.json'),(@{status='pending';version=$version;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))}
  Write-Host "Fleet agent synchronization scheduled: $syncName; source $version"
 }catch{if($syncName){Unregister-ScheduledTask -TaskName $syncName -Confirm:$false -ErrorAction SilentlyContinue};Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue;throw}
 return
}
$mutex=New-Object Threading.Mutex($false,'Global\ScriptFactory-AgentSync')
$locked=$false;$stopped=$false;$backup='';$xml='';$transcript=$false;$connected=$false;$workDir=$null;$log=$null
$deadline=(Get-Date).AddSeconds($WaitSeconds)
try{
 try{$locked=$mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds))}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(-not $locked){throw 'Another agent synchronization is active'}
 $workDir=if($task){$InstallDir}else{Join-Path $env:ProgramData ('ScriptFactoryAgentFirstSync-'+[Guid]::NewGuid().ToString('N'))}
 Protect-Directory $workDir
 $log=Join-Path $workDir 'agent-sync.log';try{Start-Transcript -LiteralPath $log -Append|Out-Null;$transcript=$true}catch{}
 function Idle {
  if($config.data_dir){$journal=Join-Path $config.data_dir 'state.json';if(Test-Path $journal){$state=Get-Content $journal -Raw|ConvertFrom-Json;if($state.active -or @($state.reports).Count){return $false}}}
  $h=Invoke-RestMethod ($config.api_url.TrimEnd('/')+'/health') -TimeoutSec 5
  return ($h.ready -eq $true -and $h.version -eq $version -and $h.un_id -ceq $config.un_id -and -not $h.maintenance.active)
 }
 do{
  $idle=$false;try{$idle=Idle}catch{}
  if($idle){
   if($task){
    # Freeze dispatch, then recheck the durable journal to close the idle/stop race.
    Disable-ScheduledTask -TaskName $TaskName|Out-Null;Stop-ScheduledTask -TaskName $TaskName;$stopped=$true
    $pattern=[regex]::Escape($installedConfig)
    for($i=0;$i -lt 20;$i++){$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -match $pattern});if(-not $processes.Count){break};Start-Sleep -Milliseconds 500}
    if($processes.Count){throw 'Agent process did not stop; no code replaced'}
    $idle=$false;try{$idle=Idle}catch{}
    if(-not $idle){Enable-ScheduledTask -TaskName $TaskName|Out-Null;Start-ScheduledTask -TaskName $TaskName;$stopped=$false}
   }
   if($idle){break}
  }
  if((Get-Date) -ge $deadline){throw 'AGENT_SYNC_IDLE_TIMEOUT: current operation, reports or API readiness still pending'}
  Start-Sleep -Seconds 2
 }while($true)
 if($task){
  $backup=Join-Path $InstallDir ('agent-backup-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
  foreach($name in @($runtime)+@('agent.config.json','agent-source.json')){if(Test-Path (Join-Path $InstallDir $name)){Copy-Item -LiteralPath (Join-Path $InstallDir $name) -Destination (Join-Path $backup $name)}}
  $xml=Export-ScheduledTask -TaskName $TaskName
  [IO.File]::WriteAllText((Join-Path $backup 'task.xml'),$xml,(New-Object Text.UTF8Encoding($false)))
 }
 # Snapshot settings before installer copies onto installed paths.
 $savedConfig=Join-Path $workDir ('sync-config-'+[Guid]::NewGuid().ToString('N')+'.json')
 $savedKey=Join-Path $workDir ('sync-key-'+[Guid]::NewGuid().ToString('N')+'.pem')
 Copy-Item -LiteralPath $configPath -Destination $savedConfig;Copy-Item -LiteralPath $keyPath -Destination $savedKey
 $started=(Get-Date).ToUniversalTime()
 try{& (Join-Path $SourceRoot 'windows\install-fleet-agent.ps1') -SourceRoot $SourceRoot -InstallDir $InstallDir -TaskName $TaskName -ConfigFile $savedConfig -ReleasePublicKey $savedKey}
 finally{Remove-Item -LiteralPath $savedConfig,$savedKey -Force -ErrorAction SilentlyContinue}
 $newConfig=Get-Content $installedConfig -Raw|ConvertFrom-Json
 $contact=Join-Path $newConfig.data_dir 'agent-contact.json';$connected=$false;$until=(Get-Date).AddSeconds($ContactSeconds)
 do{
  if(Test-Path $contact){try{$receipt=Get-Content $contact -Raw|ConvertFrom-Json;$connected=($receipt.node_id -ceq $config.node_id -and $receipt.source_version -eq $version -and [datetime]$receipt.at -ge $started)}catch{}}
  if($connected){break};Start-Sleep -Seconds 2
 }while((Get-Date) -lt $until)
 if(-not $connected){throw 'AGENT_SYNC_NO_CONTACT: new agent did not confirm contact with orchestrator'}
 [IO.File]::WriteAllText((Join-Path $InstallDir 'agent-sync-result.json'),(@{status='succeeded';version=$version;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
 Write-Host "Fleet agent synchronized and connected: $version"
}catch{
 $failure=$_
 if($backup -and $xml){
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $pattern=[regex]::Escape($installedConfig)
  for($i=0;$i -lt 20;$i++){$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -match $pattern});if(-not $processes.Count){break};Start-Sleep -Milliseconds 500}
  if($processes.Count){throw 'AGENT_SYNC_ROLLBACK_BLOCKED: process still running; prior files retained in agent backup'}
  foreach($name in @($runtime)+@('agent-source.json')){if(-not(Test-Path (Join-Path $backup $name))){Remove-Item -LiteralPath (Join-Path $InstallDir $name) -Force -ErrorAction SilentlyContinue}}
  foreach($file in Get-ChildItem $backup -File|Where-Object {$_.Name -ne 'task.xml'}){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $InstallDir $file.Name) -Force}
  if(-not(Test-Path (Join-Path $backup 'agent-source.json'))){Remove-Item $descriptor -Force -ErrorAction SilentlyContinue}
  Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force|Out-Null
  Enable-ScheduledTask -TaskName $TaskName|Out-Null;Start-ScheduledTask -TaskName $TaskName;$stopped=$false
 }elseif($stopped){Enable-ScheduledTask -TaskName $TaskName|Out-Null;Start-ScheduledTask -TaskName $TaskName;$stopped=$false}
 # Only a stable code is exposed in heartbeat; detailed errors stay in the protected log.
 $failureDir=if(Test-Path $installedConfig){$InstallDir}else{$workDir}
 if($failureDir -and (Test-Path $failureDir)){[IO.File]::WriteAllText((Join-Path $failureDir 'agent-sync-result.json'),(@{status='failed';error_code='AGENT_SYNC_FAILED';version=$version;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))}
 throw $failure
}finally{
 if($transcript){try{Stop-Transcript|Out-Null}catch{}}
 if($workDir -and $workDir -ne $InstallDir -and (Test-Path $InstallDir)){
  if(Test-Path $log){Copy-Item -LiteralPath $log -Destination (Join-Path $InstallDir 'agent-sync.log') -Force}
  if($connected){Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue}
 }
 if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()
 if($Scheduled){
  $syncName='ScriptFactory-AgentSync-'+(Split-Path $SourceRoot -Leaf)
  Unregister-ScheduledTask -TaskName $syncName -Confirm:$false -ErrorAction SilentlyContinue
  # Keep protected staging on failure for inspection; remove successful request/secrets.
  if($connected){Remove-Item -LiteralPath $SourceRoot -Recurse -Force -ErrorAction SilentlyContinue}
 }
}
