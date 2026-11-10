param(
 [Parameter(Mandatory=$true)][string]$ConfigFile,
 [Parameter(Mandatory=$true)][string]$ReleasePublicKey,
 [string]$InstallDir='C:\ProgramData\ScriptFactoryAgent',
 [string]$SourceRoot=(Split-Path -Parent $PSScriptRoot),
 [string]$TaskName='ScriptFactory-Fleet-Agent'
)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer as administrator'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
if([int]((& $node --version).Trim().TrimStart('v').Split('.')[0]) -lt 24){throw 'Node.js 24+ required'}
$config=Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8|ConvertFrom-Json
if($config.node_id -notmatch '^[A-Za-z0-9_-]{1,100}$' -or -not $config.un_id -or $config.token.Length -lt 32 -or $config.token.StartsWith('REPLACE_')){throw 'Complete the node identity and token first'}
if(-not(Test-Path -LiteralPath $ReleasePublicKey -PathType Leaf)){throw 'Release public key file not found'}
foreach($relative in @('fleet\agent.mjs','fleet\common.mjs','fleet\windows-adapter.mjs','fleet\run-update.ps1','fleet\rollback-update.ps1','windows\fleet-agent-host.ps1','windows\worker-job.cs','docs\project-guide\tools\update-one-un.ps1')){if(-not(Test-Path -LiteralPath (Join-Path $SourceRoot $relative) -PathType Leaf)){throw "Installer source missing: $relative"}}
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$project=[IO.Path]::GetFullPath($config.project_path).TrimEnd('\')
if($InstallDir -eq $project -or $InstallDir.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Agent must be outside the worker project'}
if(-not(Test-Path -LiteralPath $config.env_file)){throw 'Worker .env not found'}
$old=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($old -and $old.State -eq 'Running'){throw 'Stop the agent at an idle boundary before upgrading its own installation'}
if((Test-Path -LiteralPath $InstallDir) -and -not $old){throw 'Installation directory already exists without a registered agent; inspect and prepare a clean protected directory'}
if($old -and $old.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')){throw 'Existing task is not the expected SYSTEM agent'}
New-Item -ItemType Directory -Path $InstallDir -Force|Out-Null
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
foreach($sid in @('S-1-5-18','S-1-5-32-544')){
 $identity=New-Object Security.Principal.SecurityIdentifier($sid)
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $InstallDir -AclObject $acl
foreach($file in @('agent.mjs','common.mjs','windows-adapter.mjs','run-update.ps1','rollback-update.ps1')){Copy-Item -LiteralPath (Join-Path $SourceRoot ('fleet\'+$file)) -Destination (Join-Path $InstallDir $file) -Force}
Copy-Item -LiteralPath (Join-Path $SourceRoot 'docs\project-guide\tools\update-one-un.ps1') -Destination (Join-Path $InstallDir 'update-one-un.ps1') -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot 'windows\fleet-agent-host.ps1') -Destination (Join-Path $InstallDir 'agent-host.ps1') -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot 'windows\worker-job.cs') -Destination (Join-Path $InstallDir 'worker-job.cs') -Force
Copy-Item -LiteralPath $ReleasePublicKey -Destination (Join-Path $InstallDir 'release-public.pem') -Force
$config.release_public_key=Join-Path $InstallDir 'release-public.pem'
$config.data_dir=Join-Path $InstallDir 'data'
New-Item -ItemType Directory -Path $config.data_dir -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $InstallDir 'agent.config.json'),($config|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
$args="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'agent-host.ps1')`" -InstallDir `"$InstallDir`" -NodePath `"$node`""
$action=New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument $args -WorkingDirectory $InstallDir
$trigger=New-ScheduledTaskTrigger -AtStartup
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger,$repeat) -Principal $principal -Settings $settings -Force|Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Fleet agent installed as SYSTEM. The existing API worker account is unchanged.'
