param([Parameter(Mandatory=$true)][string]$SourceRoot)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$passed=0
function Check($condition,[string]$message){if(-not $condition){throw $message};$script:passed++}
function Load-Function([string]$file,[string]$name){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 Check ($errors.Count -eq 0) "Syntax $file"
 $f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)|Select-Object -First 1
 if(-not $f){throw "Missing $name"};return $f.Extent.Text
}
$body='{"ready":false,"un_id":"un-test","version":"0.11.1","checks":{"database":{"status":"ok"},"filesystem":{"status":"ok"},"browser":{"status":"ok"},"maintenance":{"status":"error"}},"maintenance":{"active":true,"owner":"fleet-test","phase":"installing","ready_to_update":true}}'
$root=Join-Path $env:TEMP ('sf-health-http-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $root|Out-Null
$serverFile=Join-Path $root 'server.mjs';$portFile=Join-Path $root 'port.txt'
$js="import http from 'node:http';const body="+($body|ConvertTo-Json -Compress)+";const s=http.createServer((req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end(body);});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"
[IO.File]::WriteAllText($serverFile,$js,(New-Object Text.UTF8Encoding($false)))
$server=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('"'+$serverFile+'"') -PassThru -WindowStyle Hidden -RedirectStandardOutput $portFile -RedirectStandardError (Join-Path $root 'error.txt')
try{
 $Port=$null;$deadline=(Get-Date).AddSeconds(20)
 do{if(Test-Path $portFile){$text=Get-Content $portFile -Raw;if($text -and $text.Trim()){$Port=[int]$text.Trim();break}};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $deadline)
 if(-not $Port){throw 'Test HTTP server did not start'}
 $MaintenanceOwner='fleet-test'
 . ([scriptblock]::Create((Load-Function (Join-Path $SourceRoot 'docs\project-guide\tools\update-one-un.ps1') 'Read-Health')))
 . ([scriptblock]::Create((Load-Function (Join-Path $SourceRoot 'docs\project-guide\tools\update-one-un.ps1') 'Test-Ready')))
 $h=Read-Health;Check ($h.un_id -eq 'un-test') '503 body survives PowerShell consumed response stream'
 Check (Test-Ready $h) 'Own drained maintenance does not mean unhealthy API'
 $MaintenanceOwner='other-owner';Check (-not(Test-Ready $h)) 'Other maintenance owner remains blocked'
 $MaintenanceOwner='';$failed=$false;try{Read-Health|Out-Null}catch{$failed=$true};Check $failed '503 without authorized maintenance remains an error'
 $MaintenanceOwner='fleet-test'
 foreach($relative in @('fleet\rollback-update.ps1','fleet\config-update.ps1')){
  . ([scriptblock]::Create((Load-Function (Join-Path $SourceRoot $relative) 'Health')))
  $h=Health;Check ($h.un_id -eq 'un-test' -and $h.maintenance.phase -eq 'installing') "503 body parsed by $relative"
 }

 $installer=Join-Path $SourceRoot 'windows\install-fleet-agent.ps1';$tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$errors);Check ($errors.Count -eq 0) 'Installer syntax'
 $guard=$ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$old' -and $n.Extent.Text.Contains('Existing task is not the expected SYSTEM agent')},$true)|Select-Object -First 1
 if(-not $guard){throw 'SYSTEM account guard not found'}
 $localized=(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')).Translate([Security.Principal.NTAccount]).Value
 foreach($identity in @('S-1-5-18',$localized)){
  $old=[pscustomobject]@{Principal=[pscustomobject]@{UserId=$identity}}
  . ([scriptblock]::Create($guard.Extent.Text));Check $true "SYSTEM identity accepted: $identity"
 }
 $old=[pscustomobject]@{Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name}}
 $blocked=$false;try{. ([scriptblock]::Create($guard.Extent.Text))}catch{$blocked=$_.Exception.Message -match 'SYSTEM agent'}
 Check $blocked 'Non-SYSTEM task remains rejected'
 [Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot 'windows\deploy-fleet-agents.ps1'),[ref]$tokens,[ref]$errors)|Out-Null
 Check ($errors.Count -eq 0) 'Bootstrap syntax with localized principal'
 Write-Output "PASS: $script:passed checks"
}finally{if($server -and -not $server.HasExited){Stop-Process -Id $server.Id -Force};Remove-Item -LiteralPath $root -Recurse -Force}
