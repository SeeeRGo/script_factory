[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [Parameter(Mandatory=$true)][string]$InventoryCsv,
  [ValidateRange(1,2592000)][int]$UserIdleSeconds=1800,
  [ValidateRange(5,86400)][int]$CheckIntervalSeconds=60,
  [ValidateRange(0,3600)][int]$GraceSeconds=30,
  [ValidateSet('sleep','hibernate','shutdown')][string]$PowerMode='sleep',
  [switch]$Background,
  [switch]$EnableSleep,
  [string]$ResultCsv=''
)
$ErrorActionPreference='Stop'
$rows=@(Import-Csv -LiteralPath $InventoryCsv)
$results=@()
foreach($row in $rows) {
 $target=$row.ApiUrl
 $safeApplied=$false;$armingAttempted=$false
 try {
  $uri=[Uri]$target
  if(-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -notin @('','/')) {throw 'ApiUrl must be a root http(s) URL without credentials/query'}
  if(-not $row.ApiKeyEnv) {throw 'ApiKeyEnv is required'}
  $key=[Environment]::GetEnvironmentVariable($row.ApiKeyEnv)
  if(-not $key) {throw 'API key environment variable is empty'}
  $headers=@{'X-API-Key'=$key}
  $base=$target.TrimEnd('/')
  if(-not $PSCmdlet.ShouldProcess($base,'Configure Windows suspend policy')) {continue}
  $power=Invoke-RestMethod "$base/api/v2/system/power/status" -Headers $headers -TimeoutSec 15
  if(-not $power.supported) {throw 'Windows suspend is unavailable on this OS; install API 0.7.0+ on Windows'}
  $patch=@{mode=$PowerMode;enabled=$true;background_enabled=[bool]$Background;dry_run=$true;user_idle_seconds=$UserIdleSeconds;check_interval_seconds=$CheckIntervalSeconds;grace_seconds=$GraceSeconds}
  # An empty ExcludedUser leaves the API process account (or existing setting) unchanged.
  if($row.ExcludedUser) {$patch.excluded_user=$row.ExcludedUser}
  $body=[Text.Encoding]::UTF8.GetBytes(($patch|ConvertTo-Json -Compress))
  $response=Invoke-RestMethod "$base/api/v2/system/power/config" -Method Patch -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 20
  $safeApplied=$true
  if($EnableSleep) {
   $snapshot=Invoke-RestMethod "$base/api/v2/system/power/sessions" -Headers $headers -TimeoutSec 30
   $transitionSupported=if($PowerMode -eq 'shutdown'){$true}elseif($PowerMode -eq 'hibernate'){$snapshot.hibernate_supported}else{$snapshot.suspend_supported}
   if(-not $snapshot.complete -or -not $transitionSupported -or -not $snapshot.suspend_privilege) {throw 'Selected power mode or session permissions unavailable; dry-run remains enabled'}
   $armingAttempted=$true
   $response=Invoke-RestMethod "$base/api/v2/system/power/config" -Method Patch -Headers $headers -ContentType 'application/json' -Body '{"dry_run":false}' -TimeoutSec 20
  }
  $results+=[pscustomobject]@{ApiUrl=$base;Configured=$true;DryRun=$response.config.dry_run;Background=$response.config.background_enabled;Error=''}
 } catch {
  # Never print HTTP headers, request payloads, secrets or raw exception objects.
  $results+=[pscustomobject]@{ApiUrl=$target;Configured=$false;DryRun=$(if($safeApplied -and -not $armingAttempted){$true}else{$null});Background=$null;Error='Configuration failed; inspect power/config and power/sessions before retry'}
 }
}
if($ResultCsv) {$results|Export-Csv -LiteralPath $ResultCsv -NoTypeInformation -Encoding UTF8}
$results
if(@($results|Where-Object {-not $_.Configured}).Count -gt 0) {exit 1}
