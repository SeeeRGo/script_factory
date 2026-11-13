param([Parameter(Mandatory=$true)][string]$Repository)
$ErrorActionPreference='Stop'
. (Join-Path $Repository 'windows\deployment-state.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('sf-deploy-test-'+[guid]::NewGuid().ToString('N'))
New-Item $root -ItemType Directory|Out-Null
$script:passed=0
function Check($condition,[string]$message){if(-not $condition){throw $message};$script:passed++}
function Write-File([string]$p,[string]$text){New-Item (Split-Path $p) -ItemType Directory -Force|Out-Null;[IO.File]::WriteAllText($p,$text)}
function Fixture([string]$p){
 New-Item (Join-Path $p 'node_modules') -ItemType Directory -Force|Out-Null
 foreach($rel in @('src\server.js','windows\start-worker.ps1','windows\install-task.ps1')){Write-File (Join-Path $p $rel) '# fixture'}
 Write-File (Join-Path $p 'package.json') '{"name":"script-factory","version":"1.0.0"}'
 Write-File (Join-Path $p 'package-lock.json') '{"name":"script-factory","version":"1.0.0"}'
 Write-File (Join-Path $p '.env') "UN_ID=test-node`nAPI_KEY=test-only`nWEB_PASSWORD=test-only`nPORT=33001`nDATA_DIR=data"
}
try{
 $p=Join-Path $root 'classification'
 Check ((Get-SFInstallationState $p).state -eq 'absent') 'Absent folder'
 New-Item $p -ItemType Directory|Out-Null
 Check ((Get-SFInstallationState $p).state -eq 'repair') 'Empty folder'
 Fixture $p
 Check ((Get-SFInstallationState $p).state -eq 'update') 'Complete installation'
 Write-File (Join-Path $p 'package.json') '{invalid'
 Check ((Get-SFInstallationState $p).state -eq 'repair') 'Malformed package'
 Fixture $p;Remove-Item (Join-Path $p 'src\server.js')
 Check ((Get-SFInstallationState $p).state -eq 'repair') 'Missing executable'
 Fixture $p;Remove-Item (Join-Path $p '.env')
 Check ((Get-SFInstallationState $p).state -eq 'repair') 'Missing env'
 Check (-not(Test-SFInside ($p+'-other') $p)) 'Sibling path is outside'
 # Mock all OS operations. No real tasks, processes, firewall, npm or API are touched.
 function icacls.exe {$global:LASTEXITCODE=0}
 function cmd.exe {New-Item (Join-Path (Get-Location) 'node_modules') -ItemType Directory -Force|Out-Null;$global:LASTEXITCODE=0}
 function Get-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction)
  if($TaskName -like '*-Worker' -and -not $global:SFTesthasWorker){return}
  if($global:SFTesthasTask){[pscustomobject]@{Actions=@{Arguments="-ProjectPath `"$global:SFTestproject`""};Settings=@{Enabled=$true}}}
 }
 function Export-ScheduledTask {param($TaskName,$TaskPath) '<Task />'}
 function Disable-ScheduledTask {param($TaskName,$TaskPath)}
 function Stop-ScheduledTask {param($TaskName,$TaskPath)}
 function Enable-ScheduledTask {param($TaskName,$TaskPath)}
 function Start-ScheduledTask {param($TaskName,$TaskPath)}
 function Start-Sleep {param($Seconds,$Milliseconds)}
 function Get-CimInstance {param($ClassName) if($global:SFTestbusyProcess){[pscustomobject]@{ProcessId=123456;CommandLine=$global:SFTestproject+'\src\server.js'}}}
 function Get-NetTCPConnection {param($LocalPort,$State,$ErrorAction)}
 function Invoke-RestMethod {param($Uri,$TimeoutSec)
  if($Uri.EndsWith('/health')){return @{queue=@{running=$global:SFTestqueued;queued=0}}}
  return @{version='2.0.0';un_id='test-node'}
 }
 $release=Join-Path $root 'release';Fixture $release
 Remove-Item (Join-Path $release '.env')
 Remove-Item (Join-Path $release 'node_modules') -Recurse
 Write-File (Join-Path $release 'package.json') '{"name":"script-factory","version":"2.0.0"}'
 Write-File (Join-Path $release 'windows\install-task.ps1') 'param($ProjectPath,$TaskName,$TaskPath,$RunAsUser,$Port,[switch]$SkipDependencyInstall);if($global:SFTestFailInstall){throw "fixture install failed"}'
 Write-File (Join-Path $release 'docs\project-guide\tools\update-one-un.ps1') 'param($ProjectPath,$PackageZip,$ExpectedVersion,$ExpectedSha256,$TaskName,$TaskPath,$Port,$BackupRoot,[switch]$ConfirmNoNewJobs,[switch]$ConfirmReplaceCode);Write-Output "UPDATE_CALLED"'
 $zip=Join-Path $root 'release.zip';Compress-Archive -Path (Join-Path $release '*') -DestinationPath $zip
 $hash=(Get-FileHash $zip).Hash;$envPath=Join-Path $root 'node.env'
 Write-File $envPath "UN_ID=test-node`nAPI_KEY=test-only`nWEB_PASSWORD=test-only`nPORT=33001`nDATA_DIR=data"
 $installer=Join-Path $Repository 'windows\deploy-one-un.ps1'
 $global:SFTestproject=Join-Path $root 'application';$backup=Join-Path $root 'backups'
 $args=@{PackageZip=$zip;ExpectedVersion='2.0.0';ExpectedSha256=$hash;ProjectPath=$global:SFTestproject;EnvFile=$envPath;BackupRoot=$backup;ConfirmNoNewJobs=$true;ConfirmReplaceCode=$true}
 $global:SFTesthasTask=$false;$global:SFTesthasWorker=$true;$global:SFTestqueued=0;$global:SFTestbusyProcess=$false;$global:SFTestFailInstall=$false
 $result=& $installer @args
 Check ($result.status -eq 'installed') 'New install'
 Write-File (Join-Path $global:SFTestproject 'data\kept.txt') 'persisted data'
 Write-File (Join-Path $global:SFTestproject 'custom.txt') 'local file'
 Remove-Item (Join-Path $global:SFTestproject 'src\server.js')
 $result=& $installer @args
 Check ($result.status -eq 'installed') 'Damaged installation repaired'
 Check ((Get-Content (Join-Path $global:SFTestproject 'data\kept.txt') -Raw) -eq 'persisted data') 'Internal data preserved'
 Check (Test-Path (Join-Path $result.backup 'custom.txt')) 'Old files retained in backup'
 Check ((Read-SFEnvironment (Join-Path $global:SFTestproject '.env'))['API_KEY'] -eq 'test-only') 'Existing configuration preserved'
 $global:SFTesthasTask=$true
 $result=& $installer @args
 Check ($result -contains 'UPDATE_CALLED') 'Valid installation uses updater'
 $global:SFTesthasTask=$false;Remove-Item (Join-Path $global:SFTestproject 'src\server.js');$global:SFTestqueued=1
 $failed=$false;try{& $installer @args|Out-Null}catch{$failed=$_.Exception.Message -match 'Queue is not empty'}
 Check $failed 'Pending work prevents repair'
 Check (Test-Path (Join-Path $global:SFTestproject 'data\kept.txt')) 'Queue refusal preserves data'
 $global:SFTestqueued=0;$global:SFTestbusyProcess=$true
 $failed=$false;try{& $installer @args|Out-Null}catch{$failed=$_.Exception.Message -match 'still running'}
 Check $failed 'Running process prevents replacement'
 $global:SFTestbusyProcess=$false;$global:SFTestFailInstall=$true
 $failed=$false;try{& $installer @args|Out-Null}catch{$failed=$_.Exception.Message -match 'Previous tree:'}
 Check $failed 'Failed installation retains both trees'
 Check (Test-Path (Join-Path $global:SFTestproject 'data\kept.txt')) 'Failed installation retains working data'
 $global:SFTestFailInstall=$false
 Check ((Get-SFInstallationState $global:SFTestproject).state -eq 'repair') 'Failed deployment is repairable on retry'
 $result=& $installer @args
 Check ($result.status -eq 'installed') 'Retry after failed install succeeds'
 $badArgs=$args.Clone();$badArgs.ExpectedSha256='0000'
 $failed=$false;try{& $installer @badArgs|Out-Null}catch{$failed=$_.Exception.Message -match 'checksum'}
 Check $failed 'Bad archive rejected before replacement'
 if(Get-Command node -ErrorAction SilentlyContinue){
 $db=Join-Path $global:SFTestproject 'data\state.sqlite'
 $seed=Join-Path $root 'seed.mjs'
 Write-File $seed @'
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE IF NOT EXISTS jobs(snapshot_json TEXT)');
db.exec('DELETE FROM jobs');
if(process.argv[3] !== 'empty') db.prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify({status:'queued'}));
db.close();
'@
 & node --no-warnings $seed $db queued
 if($LASTEXITCODE -ne 0){throw 'Cannot seed test SQLite'}
 Remove-Item (Join-Path $global:SFTestproject 'src\server.js')
 $failed=$false;try{& $installer @args|Out-Null}catch{$failed=$_.Exception.Message -match 'durable queue|Unfinished jobs'}
 Check $failed 'Offline durable queue blocks replacement'
 Check (Test-Path $db) 'Offline queue file retained'
 & node --no-warnings $seed $db empty
 if($LASTEXITCODE -ne 0){throw 'Cannot clear test SQLite'}
 $result=& $installer @args
 Check ($result.status -eq 'installed') 'Empty durable queue permits repair'
 }else{Write-Host 'SQLite checks skipped: Node.js not installed on test host'}
 $global:SFTesthasTask=$true;$global:SFTesthasWorker=$false
 Add-Content (Join-Path $global:SFTestproject '.env') "`nEXECUTION_MODE=broker" -Encoding UTF8
 $result=& $installer @args
 Check ($result.status -eq 'installed') 'Missing broker worker task triggers repair'
 $global:SFTesthasWorker=$true
 $unsafe=Join-Path $root 'unsafe.zip'
 $z=[IO.Compression.ZipFile]::Open($unsafe,[IO.Compression.ZipArchiveMode]::Create)
 try{$null=$z.CreateEntry('../escape.txt')}finally{$z.Dispose()}
 $badArgs=$args.Clone();$badArgs.PackageZip=$unsafe;$badArgs.ExpectedSha256=(Get-FileHash $unsafe).Hash
 $failed=$false;try{& $installer @badArgs|Out-Null}catch{$failed=$_.Exception.Message -match 'Unsafe archive'}
 Check $failed 'Archive traversal rejected'
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
[pscustomobject]@{passed=$script:passed;version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress
