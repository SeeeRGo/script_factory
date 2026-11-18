param(
 [Parameter(Mandatory=$true)][string]$CentralUrl,
 [string]$Ref,
 [string]$Remote='origin',
 [string]$Branch='main',
 [string]$SigningKey='C:\ScriptFactorySigning\release-private.pem',
 [string]$OutputDirectory='C:\ScriptFactoryReleases'
)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node -ErrorAction Stop).Source
$previous=$env:FLEET_ADMIN_TOKEN
Push-Location -LiteralPath $project
try{
 if(-not(Test-Path -LiteralPath $SigningKey -PathType Leaf)){throw "Не найден ключ подписи: $SigningKey"}
 $buildArgs=@((Join-Path $project 'scripts\fleet-release.mjs'),'build','--key',$SigningKey,'--out',$OutputDirectory)
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
 & $node (Join-Path $project 'scripts\fleet-release.mjs') publish --url $CentralUrl --manifest $release.manifest --zip $release.archive
 if($LASTEXITCODE -ne 0){throw 'Публикация не выполнена; файлы сборки сохранены'}
 Write-Output "Опубликован релиз $($release.id). Раскатку выберите отдельно в панели."
}finally{$env:FLEET_ADMIN_TOKEN=$previous;Pop-Location}
