param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ApiTaskName = 'ScriptFactory-Test-UN',
  [string]$TaskName = 'ScriptFactory-Saby',
  [string]$RunAsUser = '',
  [string]$ExecutablePath = "${env:ProgramFiles(x86)}\Tensor\Saby\saby.exe",
  [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
$ExecutablePath = [IO.Path]::GetFullPath($ExecutablePath)
$supervisor = Join-Path $ProjectPath 'windows\start-saby.ps1'
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) { throw "Supervisor not found: $supervisor" }
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw "Saby executable not found: $ExecutablePath" }
$apiTask = Get-ScheduledTask -TaskName $ApiTaskName -ErrorAction Stop
$userId = if ($RunAsUser) { $RunAsUser } else { $apiTask.Principal.UserId }
# Use the same Windows identity as the interactive API task; passwords are not stored.
$apiSid = (New-Object Security.Principal.NTAccount($apiTask.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
$sabySid = (New-Object Security.Principal.NTAccount($userId)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($apiSid -ne $sabySid) { throw 'Saby and API tasks must use the same Windows account' }
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`" -ExecutablePath `"$ExecutablePath`""
if ($LogDirectory) { $arguments += " -LogDirectory `"$([IO.Path]::GetFullPath($LogDirectory))`"" }
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument $arguments -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Saby autostart task $TaskName installed for $userId"
