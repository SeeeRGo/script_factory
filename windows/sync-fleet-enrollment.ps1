param(
 [Parameter(Mandatory=$true)][string]$CsvPath,
 [Parameter(Mandatory=$true)][string]$CentralUrl,
 [string]$OutputDirectory='C:\Deploy\enrollments',
 [switch]$RecoverExisting,
 [switch]$PlanOnly
)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node -ErrorAction Stop).Source
$temp=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.json')
$previous=$env:FLEET_ADMIN_TOKEN
try {
 & (Join-Path $PSScriptRoot 'convert-fleet-inventory.ps1') -CsvPath $CsvPath -OutFile $temp
 if(-not $env:FLEET_ADMIN_TOKEN){
  $secret=Read-Host 'Токен администратора оркестратора' -AsSecureString
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{$env:FLEET_ADMIN_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
  finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 }
 $arguments=@((Join-Path $project 'scripts\fleet-enroll.mjs'),'--url',$CentralUrl,'--inventory',$temp,'--out',$OutputDirectory)
 if($RecoverExisting){$arguments+='--recover-existing'}
 if($PlanOnly){$arguments+='--dry-run'}
 & $node @arguments
 if($LASTEXITCODE -ne 0){throw 'Синхронизация остановлена. Причина указана выше; готовые JSON сохранены.'}
}finally{
 $env:FLEET_ADMIN_TOKEN=$previous
 Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}
