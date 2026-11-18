param([Parameter(Mandatory=$true)][string]$Converter)
$ErrorActionPreference='Stop';$root=Join-Path $env:TEMP ('sf-csv-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$script:passed=0
function Check($condition,[string]$message){if(-not $condition){throw $message};$script:passed++}
function Write-Utf8([string]$p,[string]$text){[IO.File]::WriteAllText($p,$text,(New-Object Text.UTF8Encoding($false)))}
try{
 $csv=Join-Path $root 'nodes.csv';$out=Join-Path $root 'nodes.json'
 Write-Utf8 (Join-Path $root 'one.env') "UN_ID=un-one`nPORT=33001`nAPI_KEY=SECRET_DO_NOT_EXPORT`nUN_PASSWORD=OTHER_SECRET"
 Write-Utf8 (Join-Path $root 'two.env') "UN_ID=un-two`nPORT=33003"
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246,one.env`n192.168.88.247,two.env"
 & $Converter -CsvPath $csv -OutFile $out
 $text=Get-Content $out -Raw -Encoding UTF8;$nodes=$text|ConvertFrom-Json;$nodes=@($nodes)
 Check ($nodes.Count -eq 2) 'Both rows converted'
 Check ($nodes[0].id -eq 'un-one') 'Stable id from UN_ID'
 Check ($nodes[1].api_url -eq 'http://127.0.0.1:33003') 'Local API port preserved'
 Check ($nodes[1].api_address -eq 'http://192.168.88.247:33003') 'Network API address mapped'
 Check ($nodes[0].env_file -eq 'C:/script_factory/.env') 'Remote env path differs from staged EnvFile'
 Check ($text -notmatch 'SECRET|API_KEY|PASSWORD') 'No secrets exported'
 & $Converter -CsvPath $csv -OutFile $out
 Check ((Get-Content $out -Raw -Encoding UTF8) -eq $text) 'Idempotent conversion'
 Write-Utf8 $csv 'Computer,EnvFile'
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$true}
 Check $failed 'Empty source rejected'
 Check ((Get-Content $out -Raw -Encoding UTF8) -eq $text) 'Output preserved on invalid source'
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246,missing.env"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match 'EnvFile'}
 Check $failed 'Missing env reported before output'
 Write-Utf8 $csv "Computer;EnvFile;Id;ProjectPath;RdpAddress`n192.168.88.247;two.env;explicit-id;C:/api;gateway:42389"
 $single=Join-Path $root 'single.json';& $Converter -CsvPath $csv -OutFile $single
 $singleText=Get-Content $single -Raw -Encoding UTF8
 Check ($singleText.TrimStart().StartsWith('[')) 'Single node is still a JSON array'
 $singleNodes=$singleText|ConvertFrom-Json;$node=$singleNodes[0]
 Check ($node.id -eq 'explicit-id' -and $node.project_path -eq 'C:/api' -and $node.rdp_address -eq 'gateway:42389') 'Optional columns preserved'
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246,one.env`n192.168.88.247,one.env"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match 'Повторяется'}
 Check $failed 'Duplicate UN_ID rejected'
 Write-Utf8 (Join-Path $root 'one.env') "UN_ID=un-one`nPORT=70000"
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246,one.env"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match 'PORT'}
 Check $failed 'Invalid port rejected'
 Write-Utf8 (Join-Path $root 'one.env') "UN_ID=un-changed`nPORT=33001"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match '-Force'}
 Check $failed 'Different existing inventory not silently replaced'
 & $Converter -CsvPath $csv -OutFile $out -Force
 $replaced=Get-Content $out -Raw -Encoding UTF8|ConvertFrom-Json
 Check ($replaced[0].un_id -eq 'un-changed') 'Explicit replacement works'
 Write-Utf8 (Join-Path $root 'one.env') "UN_ID='Тестовая УН'`nPORT=33001"
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246,one.env"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match 'Id'}
 Check $failed 'Non-ASCII UN_ID requires explicit agent Id'
 Write-Utf8 $csv "Computer,EnvFile,Id`n192.168.88.246,one.env,russian-node"
 $unicode=Join-Path $root 'unicode.json';& $Converter -CsvPath $csv -OutFile $unicode
 $unicodeNodes=Get-Content $unicode -Raw -Encoding UTF8|ConvertFrom-Json
 Check ($unicodeNodes[0].un_id -eq 'Тестовая УН') 'Quoted Unicode UN_ID preserved'
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile (Join-Path $root 'one.env') -Force}catch{$failed=$_.Exception.Message -match 'EnvFile'}
 Check $failed 'Source env cannot be overwritten'
 Write-Utf8 $csv "Computer,EnvFile`n192.168.88.246:44389,one.env"
 $failed=$false;try{& $Converter -CsvPath $csv -OutFile $out}catch{$failed=$_.Exception.Message -match 'Computer'}
 Check $failed 'RDP endpoint cannot be mistaken for a node IP'
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
[pscustomobject]@{passed=$script:passed;version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress
