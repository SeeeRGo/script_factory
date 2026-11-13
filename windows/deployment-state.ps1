# Pure filesystem checks; no process/task changes. Dot-source from the installer/tests.
function Read-SFEnvironment([string]$Path) {
  $values=@{}
  if(Test-Path -LiteralPath $Path -PathType Leaf){
    foreach($line in [IO.File]::ReadAllLines($Path)){
      if($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$'){$values[$matches[1]]=$matches[2].Trim().Trim('"').Trim("'")}
    }
  }
  return $values
}
function Test-SFInside([string]$Path,[string]$Root) {
  $p=[IO.Path]::GetFullPath($Path).TrimEnd('\');$r=[IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $p.Equals($r,[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($r+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Get-SFInstallationState([string]$ProjectPath) {
  if(-not(Test-Path -LiteralPath $ProjectPath)){return [pscustomobject]@{state='absent';reasons=@()}}
  if(-not(Test-Path -LiteralPath $ProjectPath -PathType Container)){throw 'ProjectPath must be a directory'}
  $reasons=@()
  if(Test-Path -LiteralPath (Join-Path $ProjectPath '.sf-deploy-incomplete')){$reasons+='Previous deployment did not finish'}
  if(-not(Test-Path -LiteralPath (Join-Path $ProjectPath 'node_modules') -PathType Container)){$reasons+='Missing dependencies'}
  foreach($rel in @('package.json','package-lock.json','src\server.js','windows\start-worker.ps1','windows\install-task.ps1')){
    if(-not(Test-Path -LiteralPath (Join-Path $ProjectPath $rel) -PathType Leaf)){$reasons+="Missing $rel"}
  }
  foreach($rel in @('package.json','package-lock.json')){
    $p=Join-Path $ProjectPath $rel
    if(Test-Path -LiteralPath $p -PathType Leaf){
      try{$j=Get-Content -LiteralPath $p -Raw -Encoding UTF8|ConvertFrom-Json;if($j.name -ne 'script-factory' -or -not $j.version){$reasons+="Invalid $rel metadata"}}
      catch{$reasons+="Invalid JSON in $rel"}
    }
  }
  $config=Read-SFEnvironment (Join-Path $ProjectPath '.env')
  foreach($key in @('UN_ID','API_KEY','PORT')){if(-not $config[$key]){$reasons+="Missing configuration $key"}}
  $state=if($reasons.Count){'repair'}else{'update'}
  return [pscustomobject]@{state=$state;reasons=$reasons}
}
