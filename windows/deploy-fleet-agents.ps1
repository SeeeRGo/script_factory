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
$sourceFiles=@('package.json','fleet\agent.mjs','fleet\common.mjs','fleet\configuration.mjs','fleet\config-local.mjs','fleet\config-update.ps1','fleet\windows-adapter.mjs','fleet\run-update.ps1','fleet\rollback-update.ps1','windows\install-fleet-agent.ps1','windows\fleet-agent-host.ps1','windows\worker-job.cs','docs\project-guide\tools\update-one-un.ps1')
foreach($file in $sourceFiles){if(-not(Test-Path -LiteralPath (Join-Path $project $file) -PathType Leaf)){throw "Missing source: $file"}}
$sourceVersion=(Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
if([version]$sourceVersion -lt [version]'0.15.4'){throw 'Use the complete source bundle 0.15.4+; replacing one script is insufficient'}
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
 # Recovering keys must not invalidate installed agents before transport,
 # identity and idle-state checks have succeeded for every selected target.
 if($RecoverExisting -and -not $PlanOnly){
  if(-not $Credential){$Credential=Get-Credential -Message 'Администратор целевых УН (WinRM)'}
  if(-not $Credential){throw 'Administrative Windows credentials are required'}
  if(-not $WinRMPort){$WinRMPort=if($UseSSL){5986}else{5985}}
  foreach($n in $nodes){
   $check=$null
   try{
    $check=New-PSSession -ComputerName $n.network_address -Port $WinRMPort -UseSSL:$UseSSL -Authentication Negotiate -Credential $Credential -SessionOption (New-PSSessionOption -OpenTimeout 20000 -OperationTimeout 30000)
    Invoke-Command -Session $check -ArgumentList $n.env_file,$n.un_id,$sourceVersion,((Get-FileHash -LiteralPath $ReleasePublicKey).Hash) -ScriptBlock {
     param($envFile,$expected,$sourceVersion,$publicKeyHash)
     $ErrorActionPreference='Stop'
     $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
     if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Remote administrator rights are required before key recovery'}
     $nodeVersion=(& (Get-Command node.exe -ErrorAction Stop).Source --version).Trim().TrimStart('v').Split('.')[0]
     if([int]$nodeVersion -lt 24){throw 'Node.js 24+ required before key recovery'}
     $actual=$null;foreach($line in [IO.File]::ReadAllLines($envFile)){if($line -match '^\s*UN_ID\s*=(.*)$'){$actual=($matches[1] -replace '\s+#.*$','').Trim().Trim('"').Trim("'")}}
     if($actual -cne $expected){throw 'Actual target UN_ID does not match inventory; no keys rotated'}
     $agentTask=Get-ScheduledTask -TaskName 'ScriptFactory-Fleet-Agent' -ErrorAction SilentlyContinue
     if($agentTask){
      if($agentTask.State -eq 'Disabled'){throw 'Agent intentionally disabled; no keys rotated'}
      $account=$agentTask.Principal.UserId;$systemAccount=$account -in @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')
      if(-not $systemAccount){try{$systemAccount=((New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18')}catch{}}
      if(-not $systemAccount){throw 'Existing agent task is not SYSTEM; no keys rotated'}
     }elseif(Test-Path 'C:\ProgramData\ScriptFactoryAgent'){throw 'Orphan agent directory requires inspection; no keys rotated'}
     $installedPublic='C:\ProgramData\ScriptFactoryAgent\release-public.pem'
     if($agentTask -and (-not(Test-Path $installedPublic) -or (Get-FileHash $installedPublic).Hash -ne $publicKeyHash)){throw 'Installed signing key differs; no keys rotated'}
     $descriptor='C:\ProgramData\ScriptFactoryAgent\agent-source.json'
     if(Test-Path $descriptor){$installedVersion=(Get-Content $descriptor -Raw|ConvertFrom-Json).version;if([version]$sourceVersion -lt [version]$installedVersion){throw 'Agent downgrade refused; no keys rotated'}}
     $cfgFile='C:\ProgramData\ScriptFactoryAgent\agent.config.json'
     if(Test-Path $cfgFile){
      $installed=Get-Content $cfgFile -Raw -Encoding UTF8|ConvertFrom-Json
      if($installed.un_id -cne $expected){throw 'Installed agent UN_ID differs; no keys rotated'}
      $journal=Join-Path $installed.data_dir 'state.json'
      if(Test-Path $journal){$state=Get-Content $journal -Raw|ConvertFrom-Json;if($state.active){throw 'Installed agent has active operation; no keys rotated'}}
     }
     if(@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"|Where-Object {$_.CommandLine -match 'run-update.ps1|config-update.ps1|rollback-update.ps1|update-one-un.ps1'}).Count){throw 'Updater is active; no keys rotated'}
    }
   }finally{if($check){Remove-PSSession $check}}
  }
 }
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
   $installation=Invoke-Command -Session $session -ArgumentList $stage,([bool]$RecoverExisting) -ScriptBlock {
    param($stage,$recoverKey)
    $ErrorActionPreference='Stop'
    $install='C:\ProgramData\ScriptFactoryAgent';$task=Get-ScheduledTask -TaskName 'ScriptFactory-Fleet-Agent' -ErrorAction SilentlyContinue
    $desired=Get-Content (Join-Path $stage 'agent.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($task){
     $account=$task.Principal.UserId;$systemAccount=$account -in @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')
     if(-not $systemAccount){try{$systemAccount=((New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18')}catch{}}
     if(-not $systemAccount){throw 'Existing agent task is not SYSTEM'}
     $old=Get-Content (Join-Path $install 'agent.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
     $differences=@($desired.PSObject.Properties|Where-Object {$_.Name -notin @('release_public_key','data_dir') -and $old.($_.Name) -cne $_.Value}|ForEach-Object {$_.Name})
     if($old.un_id -cne $desired.un_id){throw 'Installed agent UN_ID differs; refusing repair'}
     $unsafe=@($differences|Where-Object {$_ -notin @('token','central_url','node_id')})
     if($unsafe.Count -or ($differences.Count -and -not $recoverKey)){throw 'Installed agent configuration differs; use -RecoverExisting only for identity/token repair; paths and other settings require explicit servicing'}
     if((Get-FileHash (Join-Path $install 'release-public.pem')).Hash -ne (Get-FileHash (Join-Path $stage 'release-public.pem')).Hash){throw 'Installed signing key differs; explicit key rotation required'}
     $runtime=@('agent.mjs','common.mjs','configuration.mjs','config-local.mjs','config-update.ps1','windows-adapter.mjs','run-update.ps1','rollback-update.ps1','agent-host.ps1','worker-job.cs','update-one-un.ps1')
     $codeChanged=$false
     foreach($name in $runtime){
      $source=if($name -eq 'agent-host.ps1'){Join-Path $stage 'windows\fleet-agent-host.ps1'}elseif($name -eq 'worker-job.cs'){Join-Path $stage 'windows\worker-job.cs'}elseif($name -eq 'update-one-un.ps1'){Join-Path $stage 'docs\project-guide\tools\update-one-un.ps1'}else{Join-Path $stage ('fleet\'+$name)}
      if(-not(Test-Path (Join-Path $install $name)) -or (Get-FileHash (Join-Path $install $name)).Hash -ne (Get-FileHash $source).Hash){$codeChanged=$true}
     }
     $descriptor=Join-Path $install 'agent-source.json'
     $sourceVersion=(Get-Content (Join-Path $stage 'package.json') -Raw|ConvertFrom-Json).version
     if(Test-Path $descriptor){$installedVersion=(Get-Content $descriptor -Raw|ConvertFrom-Json).version;if([version]$sourceVersion -lt [version]$installedVersion){throw 'Agent downgrade refused; update the controller source bundle first'}}
     if($codeChanged -or $differences.Count){
      if($task.State -eq 'Disabled'){throw 'Agent intentionally disabled; refusing automatic changes'}
      $journal=Join-Path $old.data_dir 'state.json'
      if(Test-Path $journal){$state=Get-Content $journal -Raw|ConvertFrom-Json;if($state.active){throw 'Agent has active operation; retry at idle boundary'}}
      if(@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"|Where-Object {$_.CommandLine -match 'run-update.ps1|config-update.ps1|rollback-update.ps1|update-one-un.ps1'}).Count){throw 'Updater is active; retry at idle boundary'}
      $backup=Join-Path $install ('agent-backup-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
      foreach($name in @($runtime)+@('agent.config.json','agent-source.json')){if(Test-Path (Join-Path $install $name)){Copy-Item -LiteralPath (Join-Path $install $name) -Destination (Join-Path $backup $name)}}
      $xml=Export-ScheduledTask -TaskName $task.TaskName
      [IO.File]::WriteAllText((Join-Path $backup 'task.xml'),$xml,(New-Object Text.UTF8Encoding($false)))
      Disable-ScheduledTask -TaskName $task.TaskName|Out-Null
      try{
       Stop-ScheduledTask -TaskName $task.TaskName
       $pattern=[regex]::Escape((Join-Path $install 'agent.config.json'))
       for($i=0;$i -lt 20;$i++){$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -match $pattern});if(-not $processes.Count){break};Start-Sleep -Milliseconds 500}
       if($processes.Count){throw 'Agent process did not stop; no code replaced'}
       & (Join-Path $stage 'windows\install-fleet-agent.ps1') -ConfigFile (Join-Path $stage 'agent.config.json') -ReleasePublicKey (Join-Path $stage 'release-public.pem') -SourceRoot $stage
      }catch{
       $failure=$_.Exception.Message
       foreach($file in (Get-ChildItem -LiteralPath $backup -File|Where-Object {$_.Name -ne 'task.xml'})){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $install $file.Name) -Force}
       if(-not(Test-Path (Join-Path $backup 'agent-source.json')) -and (Test-Path $descriptor)){Remove-Item -LiteralPath $descriptor -Force}
       # A newly issued key must survive code rollback: restoring the revoked
       # credential would leave an otherwise restored agent permanently offline.
       if($recoverKey -and $differences.Count){
        $configFile=Join-Path $install 'agent.config.json';$restored=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
        foreach($key in @('token','central_url','node_id')){$restored.$key=$desired.$key}
        [IO.File]::WriteAllText(($configFile+'.tmp'),($restored|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath ($configFile+'.tmp') -Destination $configFile -Force
       }
       Register-ScheduledTask -TaskName $task.TaskName -Xml $xml -Force|Out-Null;Start-ScheduledTask -TaskName $task.TaskName
       throw "Agent installation failed; prior code/task restored: $failure"
      }
      'updated'
     }else{
      if($task.State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName}
      'reused'
     }
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
