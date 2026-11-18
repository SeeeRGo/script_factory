param(
 [Parameter(Mandatory=$true)][string]$CsvPath,
 [Parameter(Mandatory=$true)][string]$OutFile,
 [string]$ProjectPath='C:/script_factory',
 [switch]$Force
)
$ErrorActionPreference='Stop'
$csv=[IO.Path]::GetFullPath($CsvPath)
$output=[IO.Path]::GetFullPath($OutFile)
if(-not(Test-Path -LiteralPath $csv -PathType Leaf)){throw "Не найден CSV-инвентарь: $csv"}
if($output -eq $csv){throw 'OutFile не должен совпадать с исходным CSV'}
if(Test-Path -LiteralPath $output -PathType Container){throw 'OutFile должен быть путём JSON-файла, а не каталогом'}
$header=Get-Content -LiteralPath $csv -Encoding UTF8|Where-Object {$_.Trim() -and -not $_.StartsWith('#')}|Select-Object -First 1
if(-not $header){throw 'CSV-инвентарь пуст'}
$delimiter=if($header.Contains(';')){';'}else{','}
$rows=@(Import-Csv -LiteralPath $csv -Delimiter $delimiter -Encoding UTF8)
if(-not $rows.Count){throw 'CSV-инвентарь не содержит УН'}
$columns=@($rows[0].PSObject.Properties.Name)
foreach($name in @('Computer','EnvFile')){if($name -notin $columns){throw "В CSV нужна колонка $name (ожидается Computer,EnvFile)"}}
function Env-Value([string]$value){
 $value=$value.Trim()
 if($value -match '^"(.*)"\s*(?:#.*)?$'){return $matches[1]}
 if($value -match "^'(.*)'\s*(?:#.*)?$"){return $matches[1]}
 return ($value -replace '\s*#.*$','').Trim()
}
$nodes=@();$ids=@{};$unIds=@{};$computers=@{}
foreach($row in $rows){
 $computer=([string]$row.Computer).Trim();$envFile=([string]$row.EnvFile).Trim()
 if(-not $computer -or [Uri]::CheckHostName($computer) -eq 'Unknown'){throw "Computer должен содержать IP или DNS без RDP-порта: $computer"}
 if(-not $envFile){throw "Не задан EnvFile для $computer"}
 if(-not [IO.Path]::IsPathRooted($envFile)){$envFile=Join-Path (Split-Path $csv -Parent) $envFile}
 if([IO.Path]::GetFullPath($envFile) -eq $output){throw 'OutFile не должен заменять исходный EnvFile'}
 if(-not(Test-Path -LiteralPath $envFile -PathType Leaf)){throw "Не найден EnvFile для ${computer}: $envFile"}
 $values=@{}
 foreach($line in [IO.File]::ReadAllLines($envFile)){
  if($line -match '^\s*(UN_ID|PORT)\s*=(.*)$'){$name=$matches[1];$raw=$matches[2];$values[$name]=Env-Value $raw}
 }
 $unId=[string]$values['UN_ID'];$port=0
 if(-not $unId.Trim() -or $unId.Length -gt 200 -or $unId -match '[\x00-\x1f]'){throw "В $envFile нужен корректный UN_ID из .env соответствующей УН"}
 if(-not [int]::TryParse([string]$values['PORT'],[ref]$port) -or $port -lt 1 -or $port -gt 65535){throw "В $envFile нужен PORT от 1 до 65535"}
 $id=if($columns -contains 'Id' -and ([string]$row.Id).Trim()){([string]$row.Id).Trim()}else{$unId}
 if($id -notmatch '^[A-Za-z0-9_-]{1,100}$' -or $id -in @('__proto__','prototype','constructor')){throw "Для UN_ID '$unId' задайте отдельную колонку Id: 1-100 латинских букв, цифр, _ или -"}
 if($ids.ContainsKey($id) -or $unIds.ContainsKey($unId) -or $computers.ContainsKey($computer)){throw "Повторяется Id, UN_ID или Computer: $computer"}
 $ids[$id]=$true;$unIds[$unId]=$true;$computers[$computer]=$true
 $project=if($columns -contains 'ProjectPath' -and ([string]$row.ProjectPath).Trim()){([string]$row.ProjectPath).Trim()}else{$ProjectPath}
 $group=if($columns -contains 'Group' -and ([string]$row.Group).Trim()){([string]$row.Group).Trim()}else{'default'}
 $builder=New-Object UriBuilder('http',$computer,$port)
 $node=[ordered]@{id=$id;un_id=$unId;group=$group;project_path=$project;env_file=($project.TrimEnd('/','\')+'/.env');api_url="http://127.0.0.1:$port";network_address=$computer;api_address=$builder.Uri.GetLeftPart([UriPartial]::Authority)}
 if($columns -contains 'RdpAddress' -and ([string]$row.RdpAddress).Trim()){$node.rdp_address=([string]$row.RdpAddress).Trim()}
 $nodes+=[pscustomobject]$node
}
# Validate the entire source before creating/replacing an output file. Never copy
# API_KEY, passwords or other env values into the registration inventory.
$json=ConvertTo-Json -InputObject @($nodes) -Depth 6
if(Test-Path -LiteralPath $output){
 if(-not $Force){
  try{$parsed=Get-Content -LiteralPath $output -Raw -Encoding UTF8|ConvertFrom-Json;$old=ConvertTo-Json -InputObject @($parsed) -Depth 6}catch{$old=$null}
  if($old -eq $json){Write-Host "Инвентарь не изменился: $output ($($nodes.Count) УН)";return}
  throw "Файл $output уже существует и отличается. Проверьте его; для осознанной замены укажите -Force."
 }
}
$parent=Split-Path $output -Parent
New-Item -ItemType Directory -Path $parent -Force|Out-Null
$temp=$output+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
try{[IO.File]::WriteAllText($temp,$json,(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temp -Destination $output -Force}
finally{if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}}
Write-Host "Подготовлен инвентарь: $output ($($nodes.Count) УН). Регистрация и обновление не запускались."
