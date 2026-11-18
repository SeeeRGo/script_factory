[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$CsvPath,
 [Parameter(Mandatory=$true)][string]$CentralUrl,
 [Parameter(Mandatory=$true)][string]$ReleasePublicKey,
 [string]$EnrollmentDirectory='C:\Deploy\enrollments',
 [string[]]$OnlyUnId=@(),
 [Management.Automation.PSCredential]$Credential,
 [switch]$UseSSL,
 [ValidateRange(0,65535)][int]$WinRMPort=0,
 [ValidateRange(30,1800)][int]$WaitSeconds=180,
 [switch]$RecoverExisting,
 [switch]$AllowQueuedDeployments,
 [switch]$PlanOnly,
 [string]$ResultCsv
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'fleet-agent-plan.ps1')
$project=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node.exe -ErrorAction Stop).Source
$base=$CentralUrl.TrimEnd('/')
$uri=[Uri]$base
if(-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -notin @('','/')){throw 'CentralUrl must be a root HTTP(S) URL'}
$sourceFiles=@('fleet\agent.mjs','fleet\common.mjs','fleet\configuration.mjs','fleet\config-local.mjs','fleet\config-update.ps1','fleet\windows-adapter.mjs','fleet\run-update.ps1','fleet\rollback-update.ps1','windows\install-fleet-agent.ps1','windows\fleet-agent-host.ps1','windows\worker-job.cs','docs\project-guide\tools\update-one-un.ps1')
foreach($file in $sourceFiles){if(-not(Test-Path -LiteralPath (Join-Path $project $file) -PathType Leaf)){throw "Missing source: $file"}}
if(-not(Test-Path -LiteralPath $ReleasePublicKey -PathType Leaf)){throw 'Release public key not found'}
$ReleasePublicKey=(Resolve-Path -LiteralPath $ReleasePublicKey).Path
$inventory=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.json')
$previous=$env:FLEET_ADMIN_TOKEN
$results=@()
function Read-Center { Invoke-RestMethod "$base/api/fleet" -Headers @{Authorization=('Bearer '+$env:FLEET_ADMIN_TOKEN)} -TimeoutSec 15 }
try{
 & (Join-Path $PSScriptRoot 'convert-fleet-inventory.ps1') -CsvPath $CsvPath -OutFile $inventory
 $parsed=Get-Content -LiteralPath $inventory -Raw -Encoding UTF8|ConvertFrom-Json
 $nodes=@($parsed)
 if($OnlyUnId.Count){
  foreach($id in $OnlyUnId){if(-not @($nodes|Where-Object {$_.un_id -ceq $id}).Count){throw "UN_ID not found in CSV: $id"}}
  $nodes=@($nodes|Where-Object {$OnlyUnId -ccontains $_.un_id})
  [IO.File]::WriteAllText($inventory,(ConvertTo-Json -InputObject @($nodes) -Depth 8),(New-Object Text.UTF8Encoding($false)))
 }
 if(-not $env:FLEET_ADMIN_TOKEN){
  $secret=Read-Host 'Токен администратора оркестратора' -AsSecureString
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{$env:FLEET_ADMIN_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 }
 $snapshot=Read-Center
 Assert-FleetBootstrapTargets -Nodes $nodes -Snapshot $snapshot -AllowQueuedDeployments:$AllowQueuedDeployments
 $arguments=@((Join-Path $project 'scripts\fleet-enroll.mjs'),'--url',$base,'--inventory',$inventory,'--out',$EnrollmentDirectory)
 if($RecoverExisting){$arguments+='--recover-existing'}
 if($PlanOnly){$arguments+='--dry-run'}
 & $node @arguments
 if($LASTEXITCODE -ne 0){throw 'Enrollment failed; see the message above'}
 if($PlanOnly){$nodes|Select-Object un_id,network_address,project_path;return}
 $snapshot=Read-Center
 # Resolve every enrollment before opening the first remote session.
 $plans=@();foreach($n in $nodes){
  $registered=@($snapshot.nodes.PSObject.Properties|ForEach-Object {$_.Value}|Where-Object {$_.un_id -ceq $n.un_id})
  if($registered.Count -ne 1){throw "Registration not found for $($n.un_id)"}
  $enrollment=Find-FleetEnrollment -Directory $EnrollmentDirectory -UnId $n.un_id -NodeId $registered[0].id -CentralUrl $base
  $plans+=@{Node=$n;Enrollment=$enrollment}
 }
 if(-not $Credential){$Credential=Get-Credential -Message 'Администратор целевых УН (WinRM)'}
 if(-not $Credential){throw 'Administrative Windows credentials are required'}
 if(-not $WinRMPort){$WinRMPort=if($UseSSL){5986}else{5985}}
 foreach($plan in $plans){
  $n=$plan.Node;$c=$plan.Enrollment.Config;$session=$null;$stage=$null
  Write-Host "УН $($n.un_id) / $($n.network_address): подключение и проверка"
  try{
   Assert-FleetBootstrapTargets -Nodes @($n) -Snapshot (Read-Center) -AllowQueuedDeployments:$AllowQueuedDeployments
   $session=New-PSSession -ComputerName $n.network_address -Port $WinRMPort -UseSSL:$UseSSL -Authentication Negotiate -Credential $Credential -SessionOption (New-PSSessionOption -OpenTimeout 20000 -OperationTimeout 120000)
   # Check actual identity before sending the enrollment token or changing tasks.
   Invoke-Command -Session $session -ArgumentList $c.env_file,$c.un_id -ScriptBlock {
    param($envFile,$expected)
    $ErrorActionPreference='Stop'
    $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Remote administrator rights are required'}
    $version=(& (Get-Command node.exe -ErrorAction Stop).Source --version).Trim().TrimStart('v').Split('.')[0]
    if([int]$version -lt 24){throw 'Node.js 24+ required on target'}
    if(-not(Test-Path -LiteralPath $envFile -PathType Leaf)){throw 'Target API .env not found'}
    $actual=$null
    foreach($line in [IO.File]::ReadAllLines($envFile)){if($line -match '^\s*UN_ID\s*=(.*)$'){$actual=($matches[1] -replace '\s+#.*$','').Trim().Trim('"').Trim("'")}}
    if($actual -cne $expected){throw 'Actual target UN_ID does not match inventory; no agent installed'}
   }
   $stage=Invoke-Command -Session $session -ScriptBlock {
    $ErrorActionPreference='Stop'
    $p=Join-Path $env:ProgramData ('ScriptFactoryAgentBootstrap-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $p|Out-Null
    & icacls.exe $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'|Out-Null
    if($LASTEXITCODE -ne 0){throw 'Cannot protect staging directory'}
    foreach($sub in @('fleet','windows','docs\project-guide\tools')){New-Item -ItemType Directory -Path (Join-Path $p $sub) -Force|Out-Null}
    $p
   }
   foreach($file in $sourceFiles){Copy-Item -LiteralPath (Join-Path $project $file) -Destination (Join-Path $stage $file) -ToSession $session}
   Copy-Item -LiteralPath $plan.Enrollment.File -Destination (Join-Path $stage 'agent.config.json') -ToSession $session
   Copy-Item -LiteralPath $ReleasePublicKey -Destination (Join-Path $stage 'release-public.pem') -ToSession $session
   $baseline=(Read-Center).nodes.($c.node_id).heartbeat_serial
   $installation=Invoke-Command -Session $session -ArgumentList $stage -ScriptBlock {
    param($stage)
    $ErrorActionPreference='Stop'
    $install='C:\ProgramData\ScriptFactoryAgent';$task=Get-ScheduledTask -TaskName 'ScriptFactory-Fleet-Agent' -ErrorAction SilentlyContinue
    $desired=Get-Content (Join-Path $stage 'agent.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($task){
     $account=$task.Principal.UserId;$systemAccount=$account -in @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')
     if(-not $systemAccount){try{$systemAccount=((New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18')}catch{}}
     if(-not $systemAccount){throw 'Existing agent task is not SYSTEM'}
     $old=Get-Content (Join-Path $install 'agent.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
     foreach($property in $desired.PSObject.Properties){if($property.Name -notin @('release_public_key','data_dir') -and $old.($property.Name) -cne $property.Value){throw 'Installed agent configuration differs; do not replace a running agent automatically'}}
     if((Get-FileHash (Join-Path $install 'release-public.pem')).Hash -ne (Get-FileHash (Join-Path $stage 'release-public.pem')).Hash){throw 'Installed signing key differs; explicit key rotation required'}
     if($task.State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName}
     'reused'
    }else{
     & (Join-Path $stage 'windows\install-fleet-agent.ps1') -ConfigFile (Join-Path $stage 'agent.config.json') -ReleasePublicKey (Join-Path $stage 'release-public.pem') -SourceRoot $stage
     'installed'
    }
   }
   Write-Host "УН $($n.un_id): агент запущен, ожидаем контакт с центром"
   $deadline=(Get-Date).AddSeconds($WaitSeconds);$connected=$false;$ready=$false;$nextNotice=Get-Date
   do{
    $state=Read-Center;$observed=$state.nodes.($c.node_id)
    if($observed.last_seen -and [long]$observed.heartbeat_serial -gt [long]$baseline){$connected=$true;$ready=($observed.api_ready -eq $true);if($ready){break}}
    if((Get-Date) -ge $nextNotice){Write-Host "УН $($n.un_id): ждём контакт агента и готовность API";$nextNotice=(Get-Date).AddSeconds(15)}
    Start-Sleep -Seconds 3
   }while((Get-Date) -lt $deadline)
   if(-not $connected){throw 'AGENT_NO_HEARTBEAT: inspect C:\ProgramData\ScriptFactoryAgent\data\agent-err.log and the scheduled task'}
   if(-not $ready){throw 'AGENT_CONNECTED_API_NOT_READY: agent connected; check the local API and worker'}
   $results+=[pscustomobject]@{UnId=$n.un_id;NodeId=$c.node_id;Address=$n.network_address;Status='ready';Detail=($installation -join ' ')}
  }catch{
   $reason=$_.Exception.Message.Replace([string]$c.token,'[hidden]').Replace([string]$env:FLEET_ADMIN_TOKEN,'[hidden]')
   $results+=[pscustomobject]@{UnId=$n.un_id;NodeId=$c.node_id;Address=$n.network_address;Status='failed';Detail=$reason}
   Write-Warning "УН $($n.un_id): $reason"
  }finally{
   if($session){
    if($stage){try{Invoke-Command -Session $session -ArgumentList $stage -ScriptBlock {param($p) Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop}}catch{Write-Warning "УН $($n.un_id): staging cleanup failed; remove protected directory $stage"}}
    Remove-PSSession $session
   }
  }
 }
 if($ResultCsv){$results|Export-Csv -LiteralPath $ResultCsv -Encoding UTF8 -NoTypeInformation}
 $results
 if(@($results|Where-Object {$_.Status -ne 'ready'}).Count){throw 'Some agents are not ready; see per-node results. Repeat the same command after correcting the reported cause.'}
}finally{
 $env:FLEET_ADMIN_TOKEN=$previous
 Remove-Item -LiteralPath $inventory -Force -ErrorAction SilentlyContinue
}
