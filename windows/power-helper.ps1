param(
  [ValidateSet('Inspect','Suspend')][string]$Mode = 'Inspect',
  [Parameter(Mandatory=$true)][string]$ExcludedUser,
  [ValidateSet('sleep','hibernate')][string]$PowerMode = 'sleep',
  [ValidateRange(1,2592000)][int]$IdleSeconds = 1800,
  [int]$OwnerPid = 0
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 Add-Type -Path (Join-Path $PSScriptRoot 'power-native.cs')
 $hibernate=($PowerMode -eq 'hibernate')
 $snapshot=[ScriptFactory.PowerNative]::Inspect($ExcludedUser)
 if($Mode -eq 'Inspect') {$snapshot|ConvertTo-Json -Depth 8 -Compress;exit 0}
 $reason=[ScriptFactory.PowerNative]::BlockReason($snapshot,$IdleSeconds,$hibernate)
 if($reason) {@{suspended=$false;reason=$reason}|ConvertTo-Json -Compress;exit 0}
 if($OwnerPid -le 0 -or -not (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) {throw 'POWER_OWNER_GONE'}
 # The native method re-reads all sessions immediately before requesting sleep.
 $reason=[ScriptFactory.PowerNative]::SuspendIfIdle($ExcludedUser,$IdleSeconds,$OwnerPid,$hibernate)
 @{suspended=([string]::IsNullOrEmpty($reason));reason=$reason}|ConvertTo-Json -Compress
} catch {
 $message=$_.Exception.ToString()
 $code=if($message -match 'POWER_PRIVILEGE_MISSING') {'POWER_PRIVILEGE_MISSING'} elseif($message -match 'EXCLUDED_ACCOUNT_NOT_FOUND') {'EXCLUDED_ACCOUNT_NOT_FOUND'} elseif($message -match 'POWER_OWNER_GONE') {'POWER_OWNER_GONE'} else {'WINDOWS_POWER_ERROR'}
 @{error=@{code=$code;message='Windows power/session operation failed; check permissions, account and sleep support'}}|ConvertTo-Json -Compress
 exit 0
}
