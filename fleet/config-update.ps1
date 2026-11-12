param([ValidateSet('apply','rollback')][string]$Mode,[string]$ProjectPath,[string]$EnvFile,[string]$TaskName,[string]$TaskPath='\',[int]$Port,[string]$BackupRoot,[string]$MaintenanceOwner,[string]$PayloadFile,[string]$Backup,[string]$ResultFile,[string]$UnId)
$ErrorActionPreference='Stop'
$ProjectPath=[IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$EnvFile=[IO.Path]::GetFullPath($EnvFile)
$BackupRoot=[IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
$node=(Get-Command node.exe -ErrorAction Stop).Source
function Values {
 $r=@{};foreach($l in [IO.File]::ReadAllLines($EnvFile)){if($l -match '^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$'){$r[$matches[1]]=$matches[2].Trim().Trim('"').Trim("'")}};return $r
}
function Health {
 try{Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5}catch{
  if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 503){throw}
  $r=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream());try{$r.ReadToEnd()|ConvertFrom-Json}finally{$r.Dispose()}
 }
}
function Protect([string]$p){
 New-Item $p -ItemType Directory -Force|Out-Null
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){$id=New-Object Security.Principal.SecurityIdentifier($sid);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 Set-Acl -LiteralPath $p -AclObject $acl
}
function Stop-Tasks {
 foreach($name in @($workerName,$TaskName)){Disable-ScheduledTask -TaskName $name -TaskPath $TaskPath|Out-Null;Stop-ScheduledTask -TaskName $name -TaskPath $TaskPath}
 for($i=0;$i -lt 20;$i++){
  $running=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($EnvFile,[StringComparison]::OrdinalIgnoreCase) -ge 0})
  if($running.Count -eq 0 -and -not(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)){return}
  Start-Sleep -Milliseconds 500
 }
 throw 'Configuration processes did not stop'
}
function Start-Tasks {
 foreach($name in @($TaskName,$workerName)){Enable-ScheduledTask -TaskName $name -TaskPath $TaskPath|Out-Null;Start-ScheduledTask -TaskName $name -TaskPath $TaskPath}
}
function Wait-Healthy {
 for($i=0;$i -lt 60;$i++){
  try{$h=Health;if($h.un_id -eq $UnId -and $h.maintenance.owner -eq $MaintenanceOwner -and $h.maintenance.phase -eq 'installing'){
   $bad=@($h.checks.PSObject.Properties|Where-Object {$_.Name -ne 'maintenance' -and $_.Value.status -ne 'ok'})
   if($bad.Count -eq 0){return}
  }}catch{}
  Start-Sleep -Seconds 2
 }
 throw 'Configuration health check failed'
}
function Run-Local([string]$op){
 & $node (Join-Path $PSScriptRoot 'config-local.mjs') $op $requestFile 2>&1|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Local configuration operation failed'}
}
function Result($value){[IO.File]::WriteAllText($ResultFile,($value|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}
$stopped=$false;$started=$false;$requestFile=$null
try{
 $envValues=Values
 if($envValues['UN_ID'] -ne $UnId -or $envValues['EXECUTION_MODE'] -ne 'broker'){throw 'Configuration identity or execution mode mismatch'}
 $workerName=$envValues['WORKER_TASK_NAME'];if(-not $workerName){$workerName=$TaskName+'-Worker'}
 $apiTask=Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
 $workerTask=Get-ScheduledTask -TaskName $workerName -TaskPath $TaskPath
 if($apiTask.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM') -or [string]$workerTask.Principal.LogonType -ne 'Interactive'){throw 'Expected SYSTEM API and interactive worker tasks'}
 $h=Health
 if($h.maintenance.owner -ne $MaintenanceOwner -or $h.maintenance.phase -ne 'installing' -or -not $h.maintenance.ready_to_update -or $h.un_id -ne $UnId){throw 'Sealed and drained maintenance required'}
 $dataPath=if($envValues['DATA_DIR']){$(if([IO.Path]::IsPathRooted($envValues['DATA_DIR'])){[IO.Path]::GetFullPath($envValues['DATA_DIR'])}else{[IO.Path]::GetFullPath((Join-Path $ProjectPath $envValues['DATA_DIR']))})}else{Join-Path $ProjectPath 'data'}
 if($BackupRoot -eq $ProjectPath -or $BackupRoot.StartsWith($ProjectPath+'\',[StringComparison]::OrdinalIgnoreCase) -or $BackupRoot -eq $dataPath -or $BackupRoot.StartsWith($dataPath.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Backup root must be outside project and data'}
 Protect $BackupRoot
 if($Mode -eq 'apply'){$Backup=Join-Path $BackupRoot ('configuration-'+[guid]::NewGuid().ToString('N'));Protect $Backup}
 else{$Backup=[IO.Path]::GetFullPath($Backup);if(-not $Backup.StartsWith($BackupRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Backup path outside configured root'}}
 $requestFile=Join-Path $Backup ('request-'+[guid]::NewGuid().ToString('N')+'.json')
 $options=@{projectPath=$ProjectPath;envFile=$EnvFile;backupDir=$Backup;owner=$MaintenanceOwner;unId=$UnId;payloadFile=$PayloadFile}
 [IO.File]::WriteAllText($requestFile,($options|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
 $stopped=$true;Stop-Tasks
 if($Mode -eq 'apply'){Run-Local 'apply'}else{Run-Local 'rollback'}
 Start-Tasks;Wait-Healthy
 Result @{updated=($Mode -eq 'apply');rolled_back=($Mode -eq 'rollback');backup=$Backup}
 $started=$true
}catch{
 if($Mode -eq 'apply' -and $stopped -and $requestFile -and (Test-Path (Join-Path $Backup 'snapshot.json'))){
  try{Stop-Tasks;Run-Local 'rollback';Start-Tasks;Wait-Healthy;Result @{updated=$false;rolled_back=$true;backup=$Backup};$started=$true}catch{}
 }
 if(-not $started){if($stopped){try{Start-Tasks}catch{}};Result @{updated=$false;error_code='CONFIGURATION_OUTCOME_UNCONFIRMED';backup=$Backup}}
}finally{if($requestFile){Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue}}
