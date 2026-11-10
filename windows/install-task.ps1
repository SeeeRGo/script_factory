param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$EnvFile = '',
  [string]$TaskName = 'ScriptFactory-Test-UN',
  [string]$RunAsUser = '',
  [switch]$SkipDependencyInstall,
  [switch]$SkipPreflight,
  [ValidateSet('broker','inline')][string]$ExecutionMode='broker',
  [string]$TaskPath='\',
  [int]$Port = 33001
)

$ErrorActionPreference = 'Stop'
# Bind the default to this machine, regardless of the installer account/domain.
$userId = if ([string]::IsNullOrWhiteSpace($RunAsUser)) { "$env:COMPUTERNAME\robot" } else { $RunAsUser }
try {
  $account = New-Object System.Security.Principal.NTAccount($userId)
  $null = $account.Translate([System.Security.Principal.SecurityIdentifier])
  $userSid=$account.Translate([System.Security.Principal.SecurityIdentifier])
  $userId=$userSid.Translate([System.Security.Principal.NTAccount]).Value
} catch {
  throw "Не найдена учётная запись worker '$userId'. Создайте локального пользователя robot или задайте -RunAsUser."
}

$nodeVersion = & node --version
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) {
  throw "Для установки требуется Node.js 24+, найдено: $nodeVersion"
}

Set-Location $ProjectPath
$configurationFile = if ($EnvFile) {
  if ([IO.Path]::IsPathRooted($EnvFile)) {
    [IO.Path]::GetFullPath($EnvFile)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectPath $EnvFile))
  }
} else {
  Join-Path $ProjectPath '.env'
}
if (-not (Test-Path $configurationFile) -and -not $EnvFile) {
  Copy-Item 'windows\.env.example' '.env'
  throw 'Создан .env. Заполните секреты и повторите установку.'
}
if (-not (Test-Path $configurationFile)) {
  throw "Не найден файл конфигурации $configurationFile"
}

$portLine = Get-Content -LiteralPath $configurationFile -Encoding UTF8 | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1
$configuredPort = if ($portLine) { ($portLine -split '=',2)[1].Trim().Trim('"').Trim("'") } else { '3000' }
if ($Port -lt 1 -or $Port -gt 65535 -or [int]$configuredPort -ne $Port) { throw 'Port must match PORT in the environment file' }

$preflight = Join-Path $ProjectPath 'windows\preflight.ps1'
if(-not $SkipPreflight){& $preflight -ProjectPath $ProjectPath -EnvFile $configurationFile -Port $Port;if ($LASTEXITCODE -ne 0) { throw 'Windows preflight завершился с ошибкой' }}

if (-not $SkipDependencyInstall) {
  $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
  # npm warnings on stderr must not terminate Windows PowerShell 5.1.
  # Merge streams in cmd itself; still reject a nonzero npm exit code below.
  & cmd.exe /d /c "npm.cmd ci --omit=dev 2>&1"
  if ($LASTEXITCODE -ne 0) { throw 'npm ci завершился с ошибкой' }
}

$powerShell = (Get-Command powershell.exe).Source
$startScript = Join-Path $ProjectPath 'windows\start-worker.ps1'
try{if(-not(Get-NetFirewallRule -DisplayName 'Script Factory API' -ErrorAction SilentlyContinue)){New-NetFirewallRule -DisplayName 'Script Factory API' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port|Out-Null}}catch{Write-Warning 'Проверьте разрешение порта API в Windows Firewall'}
if($ExecutionMode -eq 'broker'){
 if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'API port is occupied. Drain jobs and stop the old API task before migration; use update-one-un.ps1 for an existing installation.'}
 if($userSid.Value -in @('S-1-5-18','S-1-5-19','S-1-5-20')){throw 'Worker requires a real interactive user account'}
 $lines=[System.Collections.Generic.List[string]]::new();foreach($line in [IO.File]::ReadAllLines($configurationFile)){$lines.Add($line)}
 function EnvValue([string]$name){foreach($line in $lines){if($line -match ('^\s*'+[regex]::Escape($name)+'\s*=(.*)$')){return $matches[1].Trim().Trim('"').Trim("'")}};return ''}
 function SetEnvValue([string]$name,[string]$value){for($i=0;$i -lt $lines.Count;$i++){if($lines[$i] -match ('^\s*'+[regex]::Escape($name)+'\s*=')){$lines[$i]=$name+'='+$value;return}};$lines.Add($name+'='+$value)}
 $workerPort=EnvValue 'WORKER_PORT';if(-not $workerPort){$workerPort=[string]($Port+1)}
 if([int]$workerPort -lt 1 -or [int]$workerPort -gt 65535 -or [int]$workerPort -eq $Port){throw 'Set a valid separate WORKER_PORT'}
 $token=EnvValue 'WORKER_AUTH_TOKEN';if($token.Length -lt 32 -or $token.StartsWith('REPLACE_')){$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$bytes=New-Object byte[] 32;$rng.GetBytes($bytes);$token=[Convert]::ToBase64String($bytes)}finally{$rng.Dispose()}}
 $workerTaskName=EnvValue 'WORKER_TASK_NAME';if(-not $workerTaskName){$workerTaskName=$TaskName+'-Worker'}
 SetEnvValue 'EXECUTION_MODE' 'broker';SetEnvValue 'WORKER_ACCOUNT' $userId;SetEnvValue 'WORKER_AUTH_TOKEN' $token;SetEnvValue 'WORKER_PORT' $workerPort;SetEnvValue 'WORKER_TASK_NAME' $workerTaskName
 if(-not(Test-Path -LiteralPath ($configurationFile+'.before-split'))){Copy-Item -LiteralPath $configurationFile -Destination ($configurationFile+'.before-split')}
 [IO.File]::WriteAllLines($configurationFile,$lines,(New-Object Text.UTF8Encoding($false)))
 $dataPath=EnvValue 'DATA_DIR';if(-not $dataPath){$dataPath=Join-Path $ProjectPath 'data'};if(-not[IO.Path]::IsPathRooted($dataPath)){$dataPath=Join-Path $ProjectPath $dataPath}
 function ProtectDirectory([string]$p,[string]$right){
  New-Item -ItemType Directory -Path $p -Force|Out-Null;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$identity=New-Object Security.Principal.SecurityIdentifier($sid);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid,$right,'ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $p -AclObject $acl
 }
 ProtectDirectory $dataPath 'Modify'
 foreach($sub in @('artifacts','worker-state','worker-logs')){ProtectDirectory (Join-Path $dataPath $sub) 'Modify'}
 $fileAcl=New-Object Security.AccessControl.FileSecurity;$fileAcl.SetAccessRuleProtection($true,$false);$fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){$identity=New-Object Security.Principal.SecurityIdentifier($sid);$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')))}
 $fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid,'Read','Allow')));Set-Acl -LiteralPath $configurationFile -AclObject $fileAcl;Set-Acl -LiteralPath ($configurationFile+'.before-split') -AclObject $fileAcl
 $workerArguments="-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ProjectPath `"$ProjectPath`" -EnvFile `"$configurationFile`" -RestartOnExit"
 $workerAction=New-ScheduledTaskAction -Execute $powerShell -Argument $workerArguments -WorkingDirectory $ProjectPath
 $workerTriggers=@((New-ScheduledTaskTrigger -AtLogOn -User $userId),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
 $workerPrincipal=New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
 $workerSettings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
 Register-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath -Action $workerAction -Trigger $workerTriggers -Principal $workerPrincipal -Settings $workerSettings -Force|Out-Null
 $apiArguments=$workerArguments+' -ApiOnly'
 $apiAction=New-ScheduledTaskAction -Execute $powerShell -Argument $apiArguments -WorkingDirectory $ProjectPath
 $apiTriggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
 $apiPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
 Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $apiAction -Trigger $apiTriggers -Principal $apiPrincipal -Settings $workerSettings -Force|Out-Null
 Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
 try{Start-ScheduledTask -TaskName $workerTaskName -TaskPath $TaskPath}catch{Write-Warning 'API запущено. Worker начнёт работу после входа пользователя.'}
 Write-Host "API: $TaskName (SYSTEM, при включении Windows). Worker: $workerTaskName ($userId, при входе)."
 return
}
if((Get-Content -LiteralPath $configurationFile -Raw) -match '(?m)^\s*EXECUTION_MODE\s*=\s*broker\s*$'){throw 'Use the saved task/environment backup to revert an existing broker installation; inline installation is only for legacy configurations'}
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ProjectPath `"$ProjectPath`" -EnvFile `"$configurationFile`" -RestartOnExit"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
Write-Host "Задача $TaskName настроена для $userId; команда запуска отправлена. Пользователь должен войти в Windows. Проверка: http://localhost:$Port/health"
