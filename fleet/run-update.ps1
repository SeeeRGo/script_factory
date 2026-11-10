param(
 [ValidateSet('update','rollback')][string]$Mode,
 [string]$ResultFile,[string]$ProjectPath,[string]$EnvFile,[string]$TaskName,[string]$TaskPath,
 [int]$Port,[string]$BackupRoot,[string]$MaintenanceOwner,
 [string]$PackageZip,[string]$ExpectedVersion,[string]$ExpectedSha256,[string]$Backup
)
$ErrorActionPreference='Stop'
$transcribing=$false
try{Start-Transcript -LiteralPath ($ResultFile+'.log') -Append -Force | Out-Null;$transcribing=$true}catch{}
try {
 if ($Mode -eq 'update') {
  & (Join-Path $PSScriptRoot 'update-one-un.ps1') -ProjectPath $ProjectPath -EnvFile $EnvFile -TaskName $TaskName -TaskPath $TaskPath -Port $Port -BackupRoot $BackupRoot -PackageZip $PackageZip -ExpectedVersion $ExpectedVersion -ExpectedSha256 $ExpectedSha256 -MaintenanceOwner $MaintenanceOwner -ResultFile $ResultFile -ConfirmNoNewJobs -ConfirmReplaceCode
 } else {
  & (Join-Path $PSScriptRoot 'rollback-update.ps1') -ProjectPath $ProjectPath -EnvFile $EnvFile -TaskName $TaskName -TaskPath $TaskPath -Port $Port -BackupRoot $BackupRoot -Backup $Backup -MaintenanceOwner $MaintenanceOwner -ResultFile $ResultFile
 }
} catch {
 if (-not (Test-Path -LiteralPath $ResultFile)) {
  # Do not send raw PowerShell errors, configuration values or secrets to the controller.
  [IO.File]::WriteAllText($ResultFile,(@{updated=$false;error_code='UPDATE_FAILED'}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
 }
 exit 1
}finally{if($transcribing){try{Stop-Transcript | Out-Null}catch{}}}
