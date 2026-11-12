param(
 [Parameter(Mandatory=$true)][string]$BundleFile,
 [Parameter(Mandatory=$true)][string]$ReleaseZip,
 [Parameter(Mandatory=$true)][string]$ExpectedSha256,
 [string]$EnrollmentDirectory='',
 [string]$ReleasePublicKey=''
)
$ErrorActionPreference='Stop'
if((Get-FileHash -LiteralPath $ReleaseZip -Algorithm SHA256).Hash -ne $ExpectedSha256){throw 'Release checksum mismatch'}
$bundle=Get-Content -LiteralPath $BundleFile -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $bundle.nodes -or @($bundle.nodes).Count -gt 1000){throw 'Expected a bootstrap export from the orchestrator'}
if($EnrollmentDirectory -and -not(Test-Path -LiteralPath $ReleasePublicKey -PathType Leaf)){throw 'Agent enrollment requires the pinned release public key'}
foreach($node in $bundle.nodes){
 if(-not $node.host -or -not $node.project_path -or -not $node.env_file -or -not $node.un_id -or -not $node.common_env){throw 'Incomplete node bootstrap metadata'}
 if($node.windows_username -and $node.windows_password){$cred=New-Object Management.Automation.PSCredential($node.windows_username,(ConvertTo-SecureString $node.windows_password -AsPlainText -Force))}
 else{$cred=Get-Credential -Message ('Administrative WinRM credentials for '+$node.host)}
 $session=$null;$localStaging=$null
 try{
  $session=New-PSSession -ComputerName $node.host -UseSSL -Credential $cred
  Invoke-Command -Session $session -ArgumentList $node.project_path -ScriptBlock {
   param($project)
   $ErrorActionPreference='Stop'
   if(Test-Path -LiteralPath $project){throw 'Existing installation: use the update workflow'}
   $p='C:\ProgramData\ScriptFactoryDeploy';New-Item $p -ItemType Directory -Force|Out-Null
   & icacls.exe $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'|Out-Null
   if($LASTEXITCODE -ne 0){throw 'Unable to restrict deployment staging'}
  }
  Copy-Item -LiteralPath $ReleaseZip -Destination C:\ProgramData\ScriptFactoryDeploy\release.zip -ToSession $session
  # Transfer secret material as a protected file, not a remoting command parameter.
  $localStaging=Join-Path $env:TEMP ('ScriptFactoryDeploy-'+[guid]::NewGuid().ToString('N'))
  New-Item $localStaging -ItemType Directory|Out-Null
  $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
  $me=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($me)
  foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')){$identity=New-Object Security.Principal.SecurityIdentifier($sid);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
  Set-Acl -LiteralPath $localStaging -AclObject $acl
  $localEnv=Join-Path $localStaging 'common.env';[IO.File]::WriteAllText($localEnv,$node.common_env,(New-Object Text.UTF8Encoding($false)))
  Copy-Item -LiteralPath $localEnv -Destination C:\ProgramData\ScriptFactoryDeploy\common.env -ToSession $session
  $installNode=@{};foreach($key in @('project_path','env_file','un_id','worker_account','saby_executable_path')){if($node.$key){$installNode[$key]=$node.$key}}
  Invoke-Command -Session $session -ArgumentList $installNode,$ExpectedSha256 -ScriptBlock {
   param($n,$sha)
   $ErrorActionPreference='Stop'
   $zip='C:\ProgramData\ScriptFactoryDeploy\release.zip';$common='C:\ProgramData\ScriptFactoryDeploy\common.env'
   if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $sha){throw 'Remote release checksum mismatch'}
   $lines=[IO.File]::ReadAllLines($common);$portLine=$lines|Where-Object {$_ -match '^PORT='}|Select-Object -First 1
   if(-not $portLine){throw 'PORT required'};$port=[int](($portLine -split '=',2)[1].Trim('"').Trim("'"))
   try{
    Expand-Archive -LiteralPath $zip -DestinationPath $n.project_path
    & (Join-Path $n.project_path 'windows\prepare-rollout-env.ps1') -ProjectPath $n.project_path -EnvFile $n.env_file -CommonEnvFile $common -UnId $n.un_id
    $args=@{ProjectPath=$n.project_path;EnvFile=$n.env_file;Port=$port}
    if($n.worker_account){$args.RunAsUser=$n.worker_account}
    & (Join-Path $n.project_path 'windows\install-task.ps1') @args
    $sabyArgs=@{ProjectPath=$n.project_path};if($n.saby_executable_path){$sabyArgs.ExecutablePath=$n.saby_executable_path}
    & (Join-Path $n.project_path 'windows\install-saby-task.ps1') @sabyArgs
   }finally{Remove-Item -LiteralPath $common -Force -ErrorAction SilentlyContinue}
  }
  if($EnrollmentDirectory){
   $enrollment=Join-Path $EnrollmentDirectory ($node.node_id+'.json')
   $config=Get-Content -LiteralPath $enrollment -Raw -Encoding UTF8|ConvertFrom-Json
   if($config.node_id -ne $node.node_id -or $config.un_id -ne $node.un_id -or $config.project_path -ne $node.project_path -or $config.env_file -ne $node.env_file){throw 'Enrollment identity or paths differ from bootstrap export'}
   Copy-Item -LiteralPath $enrollment -Destination C:\ProgramData\ScriptFactoryDeploy\agent.config.json -ToSession $session
   Copy-Item -LiteralPath $ReleasePublicKey -Destination C:\ProgramData\ScriptFactoryDeploy\release-public.pem -ToSession $session
   Invoke-Command -Session $session -ArgumentList $node.project_path -ScriptBlock {
    param($project)
    try{& (Join-Path $project 'windows\install-fleet-agent.ps1') -ConfigFile C:\ProgramData\ScriptFactoryDeploy\agent.config.json -ReleasePublicKey C:\ProgramData\ScriptFactoryDeploy\release-public.pem}
    finally{Remove-Item C:\ProgramData\ScriptFactoryDeploy\agent.config.json -Force -ErrorAction SilentlyContinue}
   }
  }
  Write-Host ('Installation completed: '+$node.node_id+' / '+$node.un_id+' / '+$node.host+'. Verify /health after robot login.')
 }catch{
  throw ('Installation failed on '+$node.node_id+' / '+$node.un_id+' / '+$node.host+'. Inspect protected local setup logs; remaining nodes were not changed.')
 }finally{if($localStaging){Remove-Item -LiteralPath $localStaging -Recurse -Force -ErrorAction SilentlyContinue};if($session){Remove-PSSession $session};$cred=$null}
}
