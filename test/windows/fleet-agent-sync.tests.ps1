param([string]$SourceRoot=(Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference='Stop'
$passed=0
function Check($condition,$message){if(-not $condition){throw $message};$script:passed++}
$root=Join-Path ([IO.Path]::GetTempPath()) ('sf-agent-sync-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$previousProgramData=$env:ProgramData;$env:ProgramData=$root
try{
 $source=Join-Path $root 'source';$windows=Join-Path $source 'windows';New-Item -ItemType Directory -Path $windows -Force|Out-Null
 $helper=Join-Path $SourceRoot 'windows/sync-installed-fleet-agent.ps1'
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
 Check ($errors.Count -eq 0) 'Helper parses'
 # Run the real script/transaction with only Windows privilege/ACL checks replaced.
 # Scheduled Tasks, HTTP and the installer are fixture adapters; all files are real temp files.
 $edits=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('$principal=') -or $_.Extent.Text.StartsWith('if(-not $principal.IsInRole')})
 $protect=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Protect-Directory'},$true)[0]
 $scriptText=[IO.File]::ReadAllText($helper)
 foreach($edit in @($edits)+@($protect)|Sort-Object {$_.Extent.StartOffset} -Descending){$replacement=if($edit -eq $protect){'function Protect-Directory($directory){New-Item -ItemType Directory -Path $directory -Force|Out-Null}'}else{''};$scriptText=$scriptText.Remove($edit.Extent.StartOffset,$edit.Extent.EndOffset-$edit.Extent.StartOffset).Insert($edit.Extent.StartOffset,$replacement)}
 $entry=Join-Path $windows 'sync-installed-fleet-agent.ps1';[IO.File]::WriteAllText($entry,$scriptText)
 $names=@('agent.mjs','common.mjs','configuration.mjs','config-local.mjs','config-update.ps1','windows-adapter.mjs','run-update.ps1','rollback-update.ps1')
 foreach($name in $names){$file=Join-Path $source ('fleet/'+$name);New-Item -ItemType Directory -Path (Split-Path $file) -Force|Out-Null;[IO.File]::WriteAllText($file,'new-code')}
 foreach($relative in @('windows/fleet-agent-host.ps1','windows/worker-job.cs','docs/project-guide/tools/update-one-un.ps1')){$file=Join-Path $source $relative;New-Item -ItemType Directory -Path (Split-Path $file) -Force|Out-Null;[IO.File]::WriteAllText($file,'new-code')}
 [IO.File]::WriteAllText((Join-Path $source '.env'),'UN_ID=fixture-un')
 [IO.File]::WriteAllText((Join-Path $source 'package.json'),' {"version":"0.17.0"}')
 [IO.File]::WriteAllText((Join-Path $windows 'install-fleet-agent.ps1'),@'
param($SourceRoot,$InstallDir,$TaskName,$ConfigFile,$ReleasePublicKey)
$global:calls.Add('install')
if($global:failInstall){throw 'fixture installation failed'}
if(-not $global:hasTask -and (Test-Path $InstallDir)){throw 'fixture orphan guard: install directory must not exist'}
New-Item -ItemType Directory -Path $InstallDir -Force|Out-Null
Copy-Item -LiteralPath $ConfigFile -Destination (Join-Path $InstallDir 'agent.config.json') -Force
Copy-Item -LiteralPath $ReleasePublicKey -Destination (Join-Path $InstallDir 'release-public.pem') -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot 'fleet/agent.mjs') -Destination (Join-Path $InstallDir 'agent.mjs') -Force
[IO.File]::WriteAllText((Join-Path $InstallDir 'agent-source.json'),' {"version":"0.17.0"}')
if($global:contact){$c=Get-Content $ConfigFile -Raw|ConvertFrom-Json;[IO.File]::WriteAllText((Join-Path $c.data_dir 'agent-contact.json'),(@{node_id=$c.node_id;source_version='0.17.0';at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json))}
'@)
 function Get-Date {$global:clock=$global:clock.AddSeconds(1);return $global:clock}
 function Get-ScheduledTask {param($TaskName,$ErrorAction) if($TaskName -like 'ScriptFactory-AgentSync-*'){return};if($global:hasTask){return [pscustomobject]@{State=$global:taskState;Principal=[pscustomobject]@{UserId='SYSTEM'}}}}
 function Disable-ScheduledTask {param($TaskName) $global:calls.Add('disable')}
 function Stop-ScheduledTask {param($TaskName,$ErrorAction) $global:calls.Add('stop')}
 function Enable-ScheduledTask {param($TaskName) $global:calls.Add('enable')}
 function Start-ScheduledTask {param($TaskName) $global:calls.Add('start')}
 function Export-ScheduledTask {param($TaskName) '<fixture-task />'}
 function Register-ScheduledTask {param($TaskName,$Xml,$Action,$Trigger,$Principal,$Settings,[switch]$Force) if($Xml){$global:calls.Add('restore-task')}else{$global:scheduledName=$TaskName;$global:scheduledAction=$Action;$global:calls.Add('schedule')}}
 function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory}}
 function New-ScheduledTaskTrigger {param([switch]$Once,$At) [pscustomobject]@{At=$At}}
 function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) [pscustomobject]@{UserId=$UserId}}
 function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$StartWhenAvailable) [pscustomobject]@{ExecutionTimeLimit=$ExecutionTimeLimit}}
 function Get-Command {param($Name) if($Name -eq 'powershell.exe'){[pscustomobject]@{Source='fixture-powershell'}}else{Microsoft.PowerShell.Core\Get-Command $Name}}

 function Get-CimInstance {param($ClassName,$Filter)}
 function Invoke-RestMethod {param($Uri,$TimeoutSec) [pscustomobject]@{ready=$true;version='0.17.0';un_id='fixture-un';maintenance=[pscustomobject]@{active=$false}}}
 function Start-Sleep {param($Seconds,$Milliseconds) $global:calls.Add('wait');if($global:clearJournal){[IO.File]::WriteAllText($global:journal,'{"active":null,"reports":[]}');$global:clearJournal=$false}}
 function Start-Transcript {param($LiteralPath,[switch]$Append)}
 function Stop-Transcript {}
 function Reset-Fixture([bool]$existing=$true){
  $global:clock=[datetime]::UtcNow;$global:hasTask=$existing;$global:taskState='Running';$global:failInstall=$false;$global:contact=$true;$global:clearJournal=$false;$global:calls=[Collections.Generic.List[string]]::new()
  $script:install=Join-Path $root ([guid]::NewGuid().ToString('N'));$script:data=Join-Path $root ([guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $data|Out-Null
  $global:journal=Join-Path $data 'state.json';[IO.File]::WriteAllText($global:journal,'{"active":null,"reports":[]}')
  $script:config=Join-Path $root ([guid]::NewGuid().ToString('N')+'.json');$script:key=Join-Path $root ([guid]::NewGuid().ToString('N')+'.pem')
  [IO.File]::WriteAllText($key,'fixture-key')
  [IO.File]::WriteAllText($config,(@{node_id='fixture-node';un_id='fixture-un';central_url='http://192.0.2.1:34001';token='fixture-credential-preserve-exactly';api_url='http://127.0.0.1:33001';project_path=$source;env_file=(Join-Path $source '.env');data_dir=$data}|ConvertTo-Json))
  if($existing){New-Item -ItemType Directory -Path $install|Out-Null;Copy-Item $config (Join-Path $install 'agent.config.json');Copy-Item $key (Join-Path $install 'release-public.pem');[IO.File]::WriteAllText((Join-Path $install 'agent.mjs'),'old-code');[IO.File]::WriteAllText((Join-Path $install 'agent-source.json'),'{"version":"0.16.0"}')}
 }
 Reset-Fixture
 $before=[IO.File]::ReadAllText((Join-Path $install 'agent.config.json'))
 & $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10
 Check ((Get-Content (Join-Path $install 'agent.mjs') -Raw) -eq 'new-code') 'Current source replaces old runtime'
 Check ([IO.File]::ReadAllText((Join-Path $install 'agent.config.json')) -ceq $before) 'Credentials, identity and custom data dir preserved byte for byte'
 Check ((Get-Content (Join-Path $install 'agent-sync-result.json') -Raw|ConvertFrom-Json).status -eq 'succeeded') 'Success requires new version contact'
 Reset-Fixture;$global:clearJournal=$true;[IO.File]::WriteAllText($global:journal,'{"active":{"phase":"installing"},"reports":[]}')
 & $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10
 Check ($global:calls.IndexOf('wait') -lt $global:calls.IndexOf('stop')) 'Active installer finishes before task stop'
 Reset-Fixture;$global:clearJournal=$true;[IO.File]::WriteAllText($global:journal,'{"active":null,"reports":[{"status":"succeeded"}]}')
 & $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10
 Check ($global:calls.IndexOf('wait') -lt $global:calls.IndexOf('stop')) 'Pending report is acknowledged before replacement'
 Reset-Fixture;$global:contact=$false;$failed=$false
 try{& $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10}catch{$failed=$_.Exception.Message -like '*AGENT_SYNC_NO_CONTACT*'}
 Check $failed 'Missing new agent contact is an error'
 Check ((Get-Content (Join-Path $install 'agent.mjs') -Raw) -eq 'old-code') 'Prior code restored when contact fails'
 Check ((Get-Content (Join-Path $install 'agent-source.json') -Raw|ConvertFrom-Json).version -eq '0.16.0') 'Prior version restored'
 Check ($global:calls.Contains('restore-task')) 'Prior task restored'
 Reset-Fixture;$global:failInstall=$true;$failed=$false
 try{& $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10}catch{$failed=$_.Exception.Message -like '*fixture installation failed*'}
 Check $failed 'Installer failure propagates'
 Check ((Get-Content (Join-Path $install 'agent.mjs') -Raw) -eq 'old-code') 'Prior code survives installer failure'
 Reset-Fixture $false
 & $entry -SourceRoot $source -InstallDir $install -ConfigFile $config -ReleasePublicKey $key -WaitSeconds 10 -ContactSeconds 10
 Check ((Get-Content (Join-Path $install 'agent-source.json') -Raw|ConvertFrom-Json).version -eq '0.17.0') 'First installation works without creating an orphan directory'
 Reset-Fixture;$global:taskState='Disabled';$failed=$false
 try{& $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10}catch{$failed=$_.Exception.Message -like '*intentionally disabled*'}
 Check ($failed -and -not $global:calls.Contains('stop')) 'Intentionally disabled agent untouched'
 Reset-Fixture
 [IO.File]::WriteAllText((Join-Path $install 'agent-source.json'),'{"version":"99.0.0"}');$failed=$false
 try{& $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10}catch{$failed=$_.Exception.Message -like '*downgrade refused*'}
 Check ($failed -and -not $global:calls.Contains('stop')) 'Downgrade blocked before task stop'
 Reset-Fixture
 & $entry -SourceRoot $source -InstallDir $install -Defer -WaitSeconds 10 -ContactSeconds 10
 Check ($global:calls.Contains('schedule') -and -not $global:calls.Contains('stop')) 'Deferred update is scheduled independently and never stops the caller'
 Check ($global:scheduledAction.Arguments -notlike '*fixture-credential*') 'No secret on scheduled command line'
 $stage=$global:scheduledAction.WorkingDirectory
 $request=Get-Content (Join-Path $stage 'request.json') -Raw|ConvertFrom-Json
 Check ($request.SourceRoot -eq $stage -and $request.Scheduled) 'Deferred task consumes immutable staged source'
 Check ((Get-Content (Join-Path $stage 'package.json') -Raw|ConvertFrom-Json).version -eq '0.17.0') 'Full source metadata staged'
 Check (-not(Test-Path (Join-Path $stage 'enrollment.json'))) 'Existing enrollment is reused without duplicate secret file'
 $global:pendingAction=$global:scheduledAction
 function Get-ScheduledTask {param($TaskName,$ErrorAction) if($TaskName -like 'ScriptFactory-AgentSync-*'){return [pscustomobject]@{Actions=@($global:pendingAction)}};if($global:hasTask){return [pscustomobject]@{State=$global:taskState;Principal=[pscustomobject]@{UserId='SYSTEM'}}}}
 $scheduledCount=@($global:calls|Where-Object {$_ -eq 'schedule'}).Count
 & $entry -SourceRoot $source -InstallDir $install -Defer -WaitSeconds 10 -ContactSeconds 10
 Check (@($global:calls|Where-Object {$_ -eq 'schedule'}).Count -eq $scheduledCount) 'Installer and API startup share one pending request for the same version'
 function Get-ScheduledTask {param($TaskName,$ErrorAction) if($TaskName -like 'ScriptFactory-AgentSync-*'){return};if($global:hasTask){return [pscustomobject]@{State=$global:taskState;Principal=[pscustomobject]@{UserId='SYSTEM'}}}}
 # Simulate dispatch racing the first idle check: the journal becomes busy after stop.
 Reset-Fixture;$global:race=$true
 function Stop-ScheduledTask {param($TaskName,$ErrorAction) $global:calls.Add('stop');if($global:race){[IO.File]::WriteAllText($global:journal,'{"active":{"phase":"assigned"},"reports":[]}');$global:race=$false;$global:clearJournal=$true}}
 & $entry -SourceRoot $source -InstallDir $install -WaitSeconds 10 -ContactSeconds 10
 Check (($global:calls|Where-Object {$_ -eq 'stop'}).Count -eq 2) 'Busy-after-stop race restarts old agent and waits again'
 Check ($global:calls.IndexOf('start') -lt $global:calls.IndexOf('install')) 'Old process resumes before any files change in the race'
 Write-Output "PASS: $passed checks"
}finally{$env:ProgramData=$previousProgramData;Remove-Item -LiteralPath $root -Recurse -Force}
