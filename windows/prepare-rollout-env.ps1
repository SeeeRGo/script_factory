param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [Parameter(Mandatory=$true)][string]$CommonEnvFile,
  [string]$UnId = '',
  [string]$EnvFile = ''
)
$ErrorActionPreference='Stop'
$ProjectPath=[IO.Path]::GetFullPath($ProjectPath)
$target=if($EnvFile){if([IO.Path]::IsPathRooted($EnvFile)){[IO.Path]::GetFullPath($EnvFile)}else{[IO.Path]::GetFullPath((Join-Path $ProjectPath $EnvFile))}}else{Join-Path $ProjectPath '.env'}
if(Test-Path -LiteralPath $target){throw 'Environment already exists; this tool is only for a new installation'}
if(-not(Test-Path -LiteralPath (Split-Path $target) -PathType Container)){throw 'Environment parent directory does not exist'}
$commonPath=[IO.Path]::GetFullPath($CommonEnvFile)
$commonText=[IO.File]::ReadAllText($commonPath)
if($commonText -match '(?m)^\s*#\s*ROLLOUT_PENDING:'){throw 'Common configuration still has unresolved customer settings'}
$values=[ordered]@{}
function Merge-Env([string]$text){
  $seen=@{}
  foreach($line in ($text -split '\r?\n')){
    if(-not $line.Trim() -or $line.TrimStart().StartsWith('#')){continue}
    if($line -notmatch '^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$'){throw 'Invalid environment line; contents hidden'}
    $name=$matches[1];$value=$matches[2].Trim()
    if($seen.ContainsKey($name)){throw "Duplicate environment key: $name"}
    $seen[$name]=$true
    $values[$name]=$value
  }
}
Merge-Env ([IO.File]::ReadAllText((Join-Path $ProjectPath 'windows\.env.example')))
Merge-Env $commonText
# Host identity comes from the inventory or this Windows machine, never from a shared UN_ID.
if([string]::IsNullOrWhiteSpace($UnId)){
  if(-not $env:COMPUTERNAME){throw 'Set -UnId explicitly; COMPUTERNAME is unavailable'}
  $UnId='un-'+$env:COMPUTERNAME.ToLowerInvariant()
}
if($UnId.Length -gt 200 -or $UnId -match '[\x00-\x1f\x7f"#]'){throw 'Invalid UN_ID; use an inventory identifier without control characters, quotes or #'}
$values['UN_ID']='"'+$UnId+'"'
foreach($key in @('API_KEY','WEB_LOGIN')){
  $value=[string]$values[$key]
  if(-not $value.Trim('"').Trim("'") -or $value -match '(?i)replace-with|change-this'){throw "Set $key in the common configuration"}
}
# Generate an individual web password if no real password was supplied.
if(-not $values['WEB_PASSWORD'] -or $values['WEB_PASSWORD'] -match '(?i)replace-with|change-this'){
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$bytes=New-Object byte[] 32;$rng.GetBytes($bytes);$values['WEB_PASSWORD']=[Convert]::ToBase64String($bytes)}finally{$rng.Dispose()}
}
# install-task.ps1 binds the account and generates this machine's transport token.
$values['EXECUTION_MODE']='inline'
$values['WORKER_ACCOUNT']=''
$values['WORKER_AUTH_TOKEN']=''
$values['WORKER_PORT']=''
$values.Remove('WORKER_TASK_NAME')|Out-Null
$values.Remove('WORKER_SESSION_ID')|Out-Null
$user=([string]$values['CALLBACK_AUTH_USERNAME']).Trim('"').Trim("'")
$password=([string]$values['CALLBACK_AUTH_PASSWORD']).Trim('"').Trim("'")
if([bool]$user -ne [bool]$password){throw 'Basic callback requires both username and password'}
# Create an empty file exclusively, restrict access, and only then write secrets.
$stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$stream.Dispose()
try{
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){
    $identity=New-Object Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')))
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  Set-Acl -LiteralPath $target -AclObject $acl
  $lines=@($values.Keys|ForEach-Object{$_+'='+$values[$_]})
  [IO.File]::WriteAllLines($target,$lines,(New-Object Text.UTF8Encoding($false)))
}catch{
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  throw 'Environment preparation failed; no values displayed'
}
Write-Host "Prepared $target for UN_ID=$UnId. Run install-task.ps1 as administrator next."
