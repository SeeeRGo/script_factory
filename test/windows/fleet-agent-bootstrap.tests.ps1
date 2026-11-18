param([Parameter(Mandatory=$true)][string]$SourceRoot)
$ErrorActionPreference='Stop'
. (Join-Path $SourceRoot 'windows\fleet-agent-plan.ps1')
$script:passed=0;$global:SFBootstrapTestEnrollCalls=0
function Check($condition,[string]$message){if(-not $condition){throw $message};$script:passed++}
function Rejected($operation,[string]$pattern){$failed=$false;$reason='no exception';try{& $operation}catch{$reason=$_.Exception.Message+" STACK: "+$_.ScriptStackTrace;$failed=$reason -match $pattern};Check $failed "Expected rejection: $pattern; actual: $reason"}
$root=Join-Path $env:TEMP ('sf-agent-plan-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $root|Out-Null
try{
 foreach($relative in @('windows\fleet-agent-plan.ps1','windows\deploy-fleet-agents.ps1','windows\publish-fleet-release.ps1','windows\sync-fleet-enrollment.ps1')){
  $tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot $relative),[ref]$tokens,[ref]$errors)|Out-Null
  Check ($errors.Count -eq 0) "PowerShell syntax: $relative"
 }
 $nodes=@([pscustomobject]@{id='new-id';un_id='same-un'})
 $snapshot='{"nodes":{"legacy":{"id":"legacy","un_id":"same-un"}},"deployments":{}}'|ConvertFrom-Json
 Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot;Check $true 'Canonical UN_ID matching'
 $snapshot.deployments|Add-Member -MemberType NoteProperty -Name 'op' -Value ([pscustomobject]@{id='op';node_id='legacy';status='queued';release_id='old-release'})
 Rejected {Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot} 'old-release'
 Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot -AllowQueuedDeployments;Check $true 'Explicit queued permission'
 foreach($status in @('assigned','draining','downloading','installing','verifying','recovery_required')){
  $snapshot.deployments.op.status=$status
  Rejected {Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot -AllowQueuedDeployments} 'unfinished operation'
 }
 $snapshot.deployments.op.status='succeeded';Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot;Check $true 'Completed operations do not block'
 $snapshot.deployments.op.node_id='other';$snapshot.deployments.op.status='installing';Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot;Check $true 'Other targets do not block'
 $config=@{node_id='legacy';un_id='same-un';central_url='http://192.168.88.252:34001';token=('x'*40)}
 $file=Join-Path $root 'legacy.json';[IO.File]::WriteAllText($file,($config|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
 $found=Find-FleetEnrollment -Directory $root -UnId 'same-un' -NodeId 'legacy' -CentralUrl 'http://192.168.88.252:34001/'
 Check ($found.File -eq $file) 'Canonical configuration found without using proposed ID'
 Rejected {Find-FleetEnrollment -Directory $root -UnId 'same-un' -NodeId 'legacy' -CentralUrl 'http://192.168.88.246:34001'} 'URL/token'
 Rejected {Find-FleetEnrollment -Directory $root -UnId 'other-un' -NodeId 'legacy' -CentralUrl 'http://192.168.88.252:34001'} 'Expected one enrollment'
 Copy-Item -LiteralPath $file -Destination (Join-Path $root 'duplicate.json')
 Rejected {Find-FleetEnrollment -Directory $root -UnId 'same-un' -NodeId 'legacy' -CentralUrl 'http://192.168.88.252:34001'} 'found 2'

 # Exercise orchestration with WinRM/HTTP adapters replaced; never install on the host.
 $fixture=Join-Path $root 'source';New-Item -ItemType Directory -Path (Join-Path $fixture 'windows') -Force|Out-Null
 foreach($file in @('deploy-fleet-agents.ps1','fleet-agent-plan.ps1','convert-fleet-inventory.ps1')){Microsoft.PowerShell.Management\Copy-Item (Join-Path $SourceRoot ('windows\'+$file)) (Join-Path $fixture ('windows\'+$file))}
 foreach($file in @('package.json','fleet\agent.mjs','fleet\common.mjs','fleet\configuration.mjs','fleet\config-local.mjs','fleet\config-update.ps1','fleet\windows-adapter.mjs','fleet\run-update.ps1','fleet\rollback-update.ps1','windows\install-fleet-agent.ps1','windows\fleet-agent-host.ps1','windows\worker-job.cs','docs\project-guide\tools\update-one-un.ps1','scripts\fleet-enroll.mjs')){
  $p=Join-Path $fixture $file;New-Item -ItemType Directory -Path (Split-Path $p -Parent) -Force|Out-Null;[IO.File]::WriteAllText($p,'fixture')
 }
 [IO.File]::WriteAllText((Join-Path $fixture 'package.json'),'{"version":"0.15.4"}')
 $global:SFBootstrapTestNode=Join-Path $root 'node.ps1'
 [IO.File]::WriteAllText($global:SFBootstrapTestNode,@'
$global:SFBootstrapTestEnrollCalls++
$inventory=$args[[Array]::IndexOf($args,'--inventory')+1];$out=$args[[Array]::IndexOf($args,'--out')+1]
if($args -contains '--dry-run'){$global:LASTEXITCODE=0;return}
New-Item -ItemType Directory -Path $out -Force|Out-Null
$parsed=Get-Content $inventory -Raw|ConvertFrom-Json
foreach($n in @($parsed)){
 $c=@{node_id=$n.id;un_id=$n.un_id;central_url='http://center:34001';token=('t'*40);env_file=$n.env_file;project_path=$n.project_path}
 [IO.File]::WriteAllText((Join-Path $out ($n.id+'.json')),($c|ConvertTo-Json))
}
$global:LASTEXITCODE=0
'@)
 function Get-Command {param($Name) if($Name -eq 'node.exe'){[pscustomobject]@{Source=$global:SFBootstrapTestNode}}else{Microsoft.PowerShell.Core\Get-Command $Name}}
 $global:SFBootstrapTestsessions=0;$global:SFBootstrapTestclosed=0;$global:SFBootstrapTestcopies=@();$global:SFBootstrapTestcleaned=0
 function New-PSSessionOption {param($OpenTimeout,$OperationTimeout) @{} }
 function New-PSSession {param($ComputerName,$Port,$UseSSL,$Authentication,$Credential,$SessionOption) $global:SFBootstrapTestsessions++;[pscustomobject]@{HostName=$ComputerName}}
 function Remove-PSSession {param($Session) $global:SFBootstrapTestclosed++}
 function Copy-Item {param($LiteralPath,$Destination,$ToSession) $global:SFBootstrapTestcopies+=@{Host=$ToSession.HostName;Path=$LiteralPath}}
 $global:SFBootstrapTestsnapshot='{"nodes":{"one":{"id":"one","un_id":"one","heartbeat_serial":0},"two":{"id":"two","un_id":"two","heartbeat_serial":0}},"deployments":{}}'|ConvertFrom-Json
 function Invoke-RestMethod {param($Uri,$Headers,$TimeoutSec) return $global:SFBootstrapTestsnapshot}
 function Invoke-Command {
  param($Session,$ArgumentList,$ScriptBlock)
  $code=$ScriptBlock.ToString()
  if($code -match 'Actual target UN_ID'){
   if($Session.HostName -eq '192.0.2.1'){throw 'Actual target UN_ID does not match inventory'}
  }elseif($code -match 'ScriptFactoryAgentBootstrap-'){return 'C:\ProgramData\MockBootstrap'}
  elseif($code -match 'Installed agent configuration differs'){
   $global:SFBootstrapTestsnapshot.nodes.two|Add-Member -Force -NotePropertyName last_seen -NotePropertyValue '2026-11-18T10:00:00Z'
   $global:SFBootstrapTestsnapshot.nodes.two|Add-Member -Force -NotePropertyName api_ready -NotePropertyValue $true
   $global:SFBootstrapTestsnapshot.nodes.two.heartbeat_serial++
   return 'installed'
  }elseif($code -match 'Remove-Item'){$global:SFBootstrapTestcleaned++}
 }
 $csv=Join-Path $root 'nodes.csv';$public=Join-Path $root 'public.pem';$out=Join-Path $root 'enrollments';$report=Join-Path $root 'result.csv'
 [IO.File]::WriteAllText($public,'public fixture')
 [IO.File]::WriteAllText((Join-Path $root 'one.env'),"UN_ID=one`nPORT=33001")
 [IO.File]::WriteAllText((Join-Path $root 'two.env'),"UN_ID=two`nPORT=33001")
 [IO.File]::WriteAllText($csv,"Computer,EnvFile`n192.0.2.1,one.env`n192.0.2.2,two.env")
 $oldToken=$env:FLEET_ADMIN_TOKEN;$env:FLEET_ADMIN_TOKEN='test-admin'
 try{
  $credential=New-Object Management.Automation.PSCredential('test',(ConvertTo-SecureString 'test' -AsPlainText -Force))
  $params=@{CsvPath=$csv;CentralUrl='http://center:34001';ReleasePublicKey=$public;EnrollmentDirectory=$out;Credential=$credential;ResultCsv=$report;WaitSeconds=30}
  Rejected {& (Join-Path $fixture 'windows\deploy-fleet-agents.ps1') @params|Out-Null} 'Some agents are not ready'
  $rows=@(Import-Csv $report)
  Check ($rows.Count -eq 2 -and $rows[0].Status -eq 'failed' -and $rows[1].Status -eq 'ready') 'Failure on first node does not prevent second'
  Check ($global:SFBootstrapTestsessions -eq 2 -and $global:SFBootstrapTestclosed -eq 2) 'All WinRM sessions closed'
  Check (@($global:SFBootstrapTestcopies|Where-Object {$_.Host -eq '192.0.2.1'}).Count -eq 0) 'Identity mismatch blocks all file/token transfer'
  Check (@($global:SFBootstrapTestcopies|Where-Object {$_.Host -eq '192.0.2.2'}).Count -eq 15) 'Only required sources, config and public key transferred'
  Check ($global:SFBootstrapTestcleaned -eq 1) 'Staged enrollment cleaned after installation'
  $before=$global:SFBootstrapTestsessions
  & (Join-Path $fixture 'windows\deploy-fleet-agents.ps1') @params -PlanOnly|Out-Null
  Check ($global:SFBootstrapTestsessions -eq $before) 'Plan-only opens no remote sessions'
  Check ($env:FLEET_ADMIN_TOKEN -eq 'test-admin') 'Caller token preserved'
  $beforeEnroll=$global:SFBootstrapTestEnrollCalls;$beforeCopies=$global:SFBootstrapTestcopies.Count
  Rejected {& (Join-Path $fixture 'windows\deploy-fleet-agents.ps1') @params -RecoverExisting|Out-Null} 'Actual target UN_ID'
  Check ($global:SFBootstrapTestEnrollCalls -eq $beforeEnroll) 'Remote failure happens before enrollment/key rotation'
  Check ($global:SFBootstrapTestcopies.Count -eq $beforeCopies) 'Failed recovery preflight transfers no secrets'

 }finally{$env:FLEET_ADMIN_TOKEN=$oldToken}

 # Execute the real remote reconciliation body against temporary files.
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'windows\deploy-fleet-agents.ps1'),[ref]$tokens,[ref]$errors)
 $remote=$ast.FindAll({param($n) $n -is [Management.Automation.Language.ScriptBlockAst] -and $n.ParamBlock -and $n.ParamBlock.Parameters.Count -eq 2 -and $n.ParamBlock.Parameters[0].Name.VariablePath.UserPath -eq 'stage' -and $n.ParamBlock.Parameters[1].Name.VariablePath.UserPath -eq 'recoverKey'},$true)|Select-Object -First 1
 if(-not $remote){throw 'Remote reconciliation body not found'}
 $global:SFAgentTestInstall=Join-Path $root 'installed-agent';$stage=Join-Path $fixture 'stage'
 New-Item -ItemType Directory -Path $global:SFAgentTestInstall,$stage -Force|Out-Null
 $global:SFAgentTestState='Running';$global:SFAgentTestStarts=0;$global:SFAgentTestInstalls=0;$global:SFAgentTestFail=$false
 function Get-ScheduledTask {param($TaskName) [pscustomobject]@{TaskName=$TaskName;State=$global:SFAgentTestState;Principal=[pscustomobject]@{UserId='S-1-5-18'}}}
 function Start-ScheduledTask {param($TaskName) $global:SFAgentTestState='Running';$global:SFAgentTestStarts++}
 function Stop-ScheduledTask {param($TaskName) $global:SFAgentTestState='Ready'}
 function Disable-ScheduledTask {param($TaskName) $global:SFAgentTestState='Disabled'}
 function Export-ScheduledTask {param($TaskName) '<Task />'}
 function Register-ScheduledTask {param($TaskName,$Xml,[switch]$Force) $global:SFAgentTestState='Ready'}
 function Get-CimInstance {param($ClassName,$Filter) @()}
 # Restore the real copy command after the WinRM orchestration test.
 Remove-Item Function:\Copy-Item
 $runtime=@('agent.mjs','common.mjs','configuration.mjs','config-local.mjs','config-update.ps1','windows-adapter.mjs','run-update.ps1','rollback-update.ps1','agent-host.ps1','worker-job.cs','update-one-un.ps1')
 foreach($name in $runtime){
  $relative=if($name -eq 'agent-host.ps1'){'windows\fleet-agent-host.ps1'}elseif($name -eq 'worker-job.cs'){'windows\worker-job.cs'}elseif($name -eq 'update-one-un.ps1'){'docs\project-guide\tools\update-one-un.ps1'}else{'fleet\'+$name}
  $file=Join-Path $stage $relative;New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force|Out-Null
  [IO.File]::WriteAllText($file,'new '+$name);[IO.File]::WriteAllText((Join-Path $global:SFAgentTestInstall $name),'old '+$name)
 }
 [IO.File]::WriteAllText((Join-Path $stage 'package.json'),' {"version":"0.15.4"}')
 [IO.File]::WriteAllText((Join-Path $stage 'release-public.pem'),'public');[IO.File]::WriteAllText((Join-Path $global:SFAgentTestInstall 'release-public.pem'),'public')
 $desired=@{node_id='one';un_id='one';token=('n'*40);central_url='http://center';project_path='C:/api';env_file='C:/api/.env';data_dir=(Join-Path $global:SFAgentTestInstall 'data');release_public_key=(Join-Path $global:SFAgentTestInstall 'release-public.pem')}
 New-Item -ItemType Directory -Path $desired.data_dir|Out-Null
 $desiredPath=Join-Path $stage 'agent.config.json';$installedPath=Join-Path $global:SFAgentTestInstall 'agent.config.json'
 [IO.File]::WriteAllText($desiredPath,($desired|ConvertTo-Json));[IO.File]::WriteAllText($installedPath,($desired|ConvertTo-Json))
 [IO.File]::WriteAllText((Join-Path $stage 'windows\install-fleet-agent.ps1'),@'
param($ConfigFile,$ReleasePublicKey,$SourceRoot)
$global:SFAgentTestInstalls++
foreach($name in @('agent.mjs','common.mjs','configuration.mjs','config-local.mjs','config-update.ps1','windows-adapter.mjs','run-update.ps1','rollback-update.ps1','agent-host.ps1','worker-job.cs','update-one-un.ps1')){
 [IO.File]::WriteAllText((Join-Path $global:SFAgentTestInstall $name),'new '+$name)
 if($global:SFAgentTestFail){throw 'fixture installation failure'}
}
Copy-Item -LiteralPath $ConfigFile -Destination (Join-Path $global:SFAgentTestInstall 'agent.config.json') -Force
[IO.File]::WriteAllText((Join-Path $global:SFAgentTestInstall 'agent-source.json'),'{"version":"0.15.4"}')
$global:SFAgentTestState='Running'
'@)
 $body=$remote.Extent.Text.Substring(1,$remote.Extent.Text.Length-2).Replace("'C:\ProgramData\ScriptFactoryAgent'",("'"+$global:SFAgentTestInstall+"'"))
 $run=[scriptblock]::Create($body)
 $result=& $run $stage $false;Check ($result -eq 'updated') 'Changed updater code automatically installed'
 Check ($global:SFAgentTestInstalls -eq 1 -and $global:SFAgentTestState -eq 'Running') 'Agent restarted after code upgrade'
 $result=& $run $stage $false;Check ($result -eq 'reused' -and $global:SFAgentTestInstalls -eq 1) 'Same code/config is idempotent'
 $desired.token='r'*40;[IO.File]::WriteAllText($desiredPath,($desired|ConvertTo-Json))
 Rejected {& $run $stage $false|Out-Null} 'Installed agent configuration differs'
 $result=& $run $stage $true;Check ($result -eq 'updated' -and (Get-Content $installedPath -Raw|ConvertFrom-Json).token -eq $desired.token) 'Explicit key repair updates installed token and restarts agent'
 [IO.File]::WriteAllText((Join-Path $stage 'package.json'),'{"version":"0.15.3"}')
 Rejected {& $run $stage $true|Out-Null} 'downgrade refused'
 [IO.File]::WriteAllText((Join-Path $stage 'package.json'),'{"version":"0.15.4"}')
 [IO.File]::WriteAllText((Join-Path $stage 'fleet\agent.mjs'),'changed again')
 $journal=Join-Path $desired.data_dir 'state.json';[IO.File]::WriteAllText($journal,'{"active":{"phase":"installing"}}')
 Rejected {& $run $stage $true|Out-Null} 'active operation'
 Remove-Item -LiteralPath $journal
 $global:SFAgentTestFail=$true
 $desired.token='z'*40;[IO.File]::WriteAllText($desiredPath,($desired|ConvertTo-Json))
 $beforeCode=Get-Content (Join-Path $global:SFAgentTestInstall 'agent.mjs') -Raw
 $beforeConfig=Get-Content $installedPath -Raw
 Rejected {& $run $stage $true|Out-Null} 'prior code/task restored'
 Check ((Get-Content (Join-Path $global:SFAgentTestInstall 'agent.mjs') -Raw) -eq $beforeCode -and (Get-Content $installedPath -Raw|ConvertFrom-Json).token -eq $desired.token) 'Failed agent upgrade restores code while retaining the new working token'
 Check ($global:SFAgentTestState -eq 'Running') 'Old agent task resumed after failed upgrade'
 Write-Output "PASS: $script:passed checks"
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
