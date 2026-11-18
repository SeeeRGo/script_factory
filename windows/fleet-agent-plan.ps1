function Assert-FleetBootstrapTargets {
 param($Nodes,$Snapshot,[switch]$AllowQueuedDeployments)
 foreach($n in $Nodes){
  $known=@($Snapshot.nodes.PSObject.Properties|ForEach-Object {$_.Value}|Where-Object {$_.un_id -ceq $n.un_id})
  if($known.Count -gt 1){throw "Ambiguous UN_ID: $($n.un_id)"}
  if(-not $known.Count){continue}
  $operations=@($Snapshot.deployments.PSObject.Properties|ForEach-Object {$_.Value}|Where-Object {$_.node_id -ceq $known[0].id})
  foreach($d in $operations){
   if($d.status -in @('assigned','draining','downloading','installing','verifying','reporting','recovery_required')){throw "UN_ID $($n.un_id): unfinished operation $($d.id) ($($d.status)); finish/recover it before bootstrap"}
   if($d.status -eq 'queued' -and -not $AllowQueuedDeployments){throw "UN_ID $($n.un_id): queued release $($d.release_id). Cancel the obsolete operation in the panel, or explicitly use -AllowQueuedDeployments to allow this package to start when the agent connects"}
  }
 }
}
function Find-FleetEnrollment {
 param([string]$Directory,[string]$UnId,[string]$NodeId,[string]$CentralUrl)
 $found=@()
 foreach($file in (Get-ChildItem -LiteralPath $Directory -Filter '*.json' -File)){
  $c=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
  if($c.un_id -ceq $UnId -and $c.node_id -ceq $NodeId){$found+=@{File=$file.FullName;Config=$c}}
 }
 if($found.Count -ne 1){throw "Expected one enrollment for $UnId / $NodeId; found $($found.Count)"}
 $c=$found[0].Config
 if($c.central_url.TrimEnd('/') -cne $CentralUrl.TrimEnd('/') -or -not $c.token -or $c.token.Length -lt 32){throw "Invalid enrollment URL/token for $UnId"}
 return $found[0]
}
