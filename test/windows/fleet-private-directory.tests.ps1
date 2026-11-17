param(
 [Parameter(Mandatory=$true)][string]$AclScriptBase64,
 [string]$OldScriptBase64=''
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
# Remove audit/ownership privileges only from this disposable test process.
# The test must succeed with ordinary WRITE_DAC access to its own directory.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public static class SFAclTestToken {
 [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] public struct Privileges { public uint Count; public Luid Id; public uint Attributes; }
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref Privileges privileges,uint length,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 public static void Remove(string name) {
  IntPtr token; if(!OpenProcessToken(Process.GetCurrentProcess().Handle,0x28,out token))throw new Exception("OpenProcessToken failed");
  try { Luid id; if(!LookupPrivilegeValue(null,name,out id))throw new Exception("LookupPrivilegeValue failed");
   var p=new Privileges{Count=1,Id=id,Attributes=4};
   if(!AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero))throw new Exception("AdjustTokenPrivileges failed");
  } finally {CloseHandle(token);}
 }
}
'@
foreach($privilege in @('SeSecurityPrivilege','SeRestorePrivilege','SeTakeOwnershipPrivilege')){[SFAclTestToken]::Remove($privilege)}
$root=Join-Path $env:TEMP ('sf-acl-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$passed=0;$oldFailure=$null
function Invoke-TestAcl([string]$EncodedSource,[string]$Directory){
 $source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedSource))
 $placeholder=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('__SF_TEST_DIRECTORY__'))
 $actual=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Directory))
 & ([ScriptBlock]::Create($source.Replace($placeholder,$actual)))
}
try{
 if($OldScriptBase64){
  $old=Join-Path $root 'old';New-Item -ItemType Directory -Path $old|Out-Null
  try{Invoke-TestAcl $OldScriptBase64 $old}catch{$oldFailure=$_.FullyQualifiedErrorId}
 }
 $directory=Join-Path $root 'Новый каталог [test] & literal';New-Item -ItemType Directory -Path $directory|Out-Null
 $file=Join-Path $directory 'keep.txt';[IO.File]::WriteAllText($file,'preserve existing files')
 $info=New-Object IO.DirectoryInfo($directory)
 $owner=$info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
 for($i=0;$i -lt 2;$i++){
  Invoke-TestAcl $AclScriptBase64 $directory
  $acl=$info.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  if(-not $acl.AreAccessRulesProtected){throw 'Inheritance must be disabled'};$passed++
  $expected=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(@($rules|Where-Object {$_.IdentityReference.Value -notin $expected -or $_.AccessControlType -ne 'Allow'}).Count){throw 'Unexpected ACL entry'};$passed++
  foreach($sid in $expected){if(-not($rules|Where-Object {$_.IdentityReference.Value -eq $sid -and $_.FileSystemRights -eq 'FullControl'})){throw 'Missing permission'};$passed++}
  if($info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner){throw 'Owner changed'};$passed++
 }
 if([IO.File]::ReadAllText($file) -ne 'preserve existing files'){throw 'Existing file changed'};$passed++
 [pscustomobject]@{passed=$passed;old_failure=$oldFailure;version=$PSVersionTable.PSVersion.ToString();privileges_removed=$true}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
