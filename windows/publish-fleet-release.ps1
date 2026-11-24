param(
 [Parameter(Mandatory=$true)][string]$CentralUrl,
 [string]$Ref,
 [string]$SourceDirectory,
 [string]$Remote='origin',
 [string]$Branch='main',
 [string]$SigningKey='C:\ScriptFactorySigning\release-private.pem',
 [string]$OutputDirectory='C:\ScriptFactoryReleases'
)
$ErrorActionPreference='Stop'
$project=if($SourceDirectory){(Resolve-Path -LiteralPath $SourceDirectory -ErrorAction Stop).Path}else{Split-Path $PSScriptRoot -Parent}
$cli=Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\fleet-release.mjs'
Write-Output "Каталог исходников: $project"
$previousEncoding=[Console]::OutputEncoding
$node=(Get-Command node -ErrorAction Stop).Source
$previous=$env:FLEET_ADMIN_TOKEN
Push-Location -LiteralPath $project
try{
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
 if(-not(Test-Path -LiteralPath $SigningKey -PathType Leaf)){throw "Не найден ключ подписи: $SigningKey"}
 $buildArgs=@($cli,'build','--key',$SigningKey,'--out',$OutputDirectory)
 if($Ref){$buildArgs+=@('--ref',$Ref)}else{$buildArgs+=@('--remote',$Remote,'--branch',$Branch);Write-Output "Получаем актуальную ветку $Remote/$Branch из Git. Локальный HEAD не используется."}
 $result=& $node @buildArgs
 if($LASTEXITCODE -ne 0){throw "Сборка не выполнена: $result"}
 $release=($result -join "`n")|ConvertFrom-Json
 Write-Output "Собран релиз $($release.version), коммит $($release.commit)"
 if(-not $release.manifest -or -not $release.archive){throw 'Сборка не вернула пути manifest/ZIP'}
 if(-not $env:FLEET_ADMIN_TOKEN){
  $secret=Read-Host 'Токен администратора оркестратора' -AsSecureString
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{$env:FLEET_ADMIN_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
  finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 }
 & $node $cli publish --url $CentralUrl --manifest $release.manifest --zip $release.archive
 if($LASTEXITCODE -ne 0){throw 'Публикация не выполнена; файлы сборки сохранены'}
 Write-Output "Опубликован релиз $($release.id). Раскатку выберите отдельно в панели."
}finally{$env:FLEET_ADMIN_TOKEN=$previous;[Console]::OutputEncoding=$previousEncoding;Pop-Location}
