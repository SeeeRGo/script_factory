param([string]$ProjectPath,[string]$EnvFile,[string]$TaskName,[string]$TaskPath='\',[int]$Port,[string]$BackupRoot,[string]$Backup,[string]$MaintenanceOwner,[string]$ResultFile)
$ErrorActionPreference='Stop'
function Within([string]$p,[string]$root) { return $p.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) }
$ProjectPath=[IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
$EnvFile=[IO.Path]::GetFullPath($EnvFile)
$BackupRoot=[IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
$Backup=[IO.Path]::GetFullPath($Backup).TrimEnd('\')
if (-not (Within $Backup $BackupRoot)) { throw 'Backup must be inside configured backup root' }
$m=Get-Content -LiteralPath (Join-Path $Backup 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if ($m.project_path -ne $ProjectPath -or $m.env_file -ne $EnvFile -or $m.task_name -ne $TaskName -or $m.task_path -ne $TaskPath) { throw 'Backup identity mismatch' }
$values=@{}
foreach($line in [IO.File]::ReadAllLines($EnvFile)) { if($line -match '^([A-Za-z_][A-Za-z_0-9]*)=(.*)$'){$values[$matches[1]]=$matches[2].Trim().Trim('"').Trim("'")} }
function Health {
 try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5 }
 catch {
  if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 503){throw}
  $reader=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
  try{$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
 }
}
$h=Health
if ($h.un_id -ne $values['UN_ID'] -or $h.maintenance.owner -ne $MaintenanceOwner -or $h.maintenance.phase -ne 'installing' -or -not $h.maintenance.ready_to_update) {throw 'Rollback requires the same drained maintenance owner'}
foreach($rel in $m.files){
 $p=[IO.Path]::GetFullPath((Join-Path $ProjectPath $rel))
 if(-not (Within $p $ProjectPath) -or $p -eq [IO.Path]::GetFullPath($EnvFile) -or (Within $p ([IO.Path]::GetFullPath($m.data_dir))) -or $p -eq [IO.Path]::GetFullPath($m.data_dir)){throw 'Unsafe backup manifest path'}
}
$listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen)
$ids=@($listeners.OwningProcess|Select-Object -Unique)
if($ids.Count -ne 1){throw 'Ambiguous API listener'}
$workerId=$ids[0];$worker=Get-CimInstance Win32_Process -Filter "ProcessId=$workerId"
if($worker.Name -ne 'node.exe' -or $worker.CommandLine.IndexOf($EnvFile,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'API process identity mismatch'}
$workerTaskName=if($values['WORKER_TASK_NAME']){$values['WORKER_TASK_NAME']}else{$TaskName+'-Worker'}
$workerTask=Get-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if($workerTask){Disable-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath|Out-Null;Stop-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath}
Disable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath|Out-Null
Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
Start-Sleep -Seconds 2
$worker=Get-CimInstance Win32_Process -Filter "ProcessId=$workerId" -ErrorAction SilentlyContinue
if($worker){if($worker.Name -ne 'node.exe' -or $worker.CommandLine.IndexOf($EnvFile,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'API PID changed'};Stop-Process -Id $workerId -Force}
for($i=0;$i -lt 20;$i++){if(-not(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)){break};Start-Sleep -Milliseconds 500}
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'Listener did not stop'}
foreach($rel in $m.files){
 $old=Join-Path (Join-Path $Backup 'code') $rel;$target=Join-Path $ProjectPath $rel
 if(Test-Path -LiteralPath $old){New-Item -ItemType Directory -Path (Split-Path $target) -Force|Out-Null;Copy-Item -LiteralPath $old -Destination $target -Force}
 elseif(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Force}
}
if($m.dependencies_changed){
 $oldModules=Join-Path $Backup 'node_modules'
 if(-not(Test-Path -LiteralPath $oldModules)){throw 'Backup dependencies are missing'}
 $current=Join-Path $ProjectPath 'node_modules'
 if(Test-Path -LiteralPath $current){Move-Item -LiteralPath $current -Destination (Join-Path $Backup ('failed-node_modules-'+[guid]::NewGuid().ToString('N')))}
 Move-Item -LiteralPath $oldModules -Destination $current
}
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml (Get-Content -LiteralPath (Join-Path $Backup 'task.xml') -Raw -Encoding UTF8) -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $Backup 'saved.env') -Destination $EnvFile -Force
if(Test-Path (Join-Path $Backup 'worker-task.xml')){Register-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath -Xml (Get-Content -LiteralPath (Join-Path $Backup 'worker-task.xml') -Raw -Encoding UTF8) -Force|Out-Null;Enable-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath|Out-Null;Start-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath}
elseif($workerTask){Unregister-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath -Confirm:$false}
Enable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath|Out-Null
Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
for($i=0;$i -lt 60;$i++){
 try{$h=Health;if($h.version -eq $m.old_version -and $h.un_id -eq $values['UN_ID'] -and $h.maintenance.owner -eq $MaintenanceOwner){
  $bad=@($h.checks.PSObject.Properties|Where-Object {$_.Name -ne 'maintenance' -and $_.Value.status -ne 'ok'})
  if($bad.Count -eq 0){$result=@{rolled_back=$true;version=$h.version};[IO.File]::WriteAllText($ResultFile,($result|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));return}
 }}catch{}
 Start-Sleep -Seconds 2
}
throw 'Previous API did not become healthy'
