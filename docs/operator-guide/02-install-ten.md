# Первоначально установить на десять УН

Первое внедрение требует административного доступа к Windows. Оркестратор не может обновить УН, на которой ещё нет совместимого API и агента.

## Подготовить один пакет и десять конфигураций

1. На одной УН пройдите [установку](01-install-one.md) и проверку после перезагрузки.
2. Соберите один ZIP точного Git commit и запишите SHA-256. На десяти УН должны быть одинаковые байты ZIP.
3. Подготовьте десять отдельных .env с одинаковыми общими настройками и индивидуальными UN_ID/ключами/путями. Не копируйте на все машины действующий WORKER_AUTH_TOKEN одной УН: первоначальные поля worker оставляйте пустыми, установщик создаст их сам.
4. На всех УН заранее установите Node.js 24+, браузер и Saby; создайте worker, настройте подписи и пользовательский сеанс. Проверьте доступность npm registry или корпоративного зеркала.

## Доставить и запустить установку партиями

Администратор может использовать существующий инструмент управления Windows или PowerShell Remoting. Для Remoting нужны настроенный WinRM, доверие и права администратора. Не отключайте проверку сертификатов ради этой инструкции. Сначала проверьте одну УН; далее обрабатывайте по одной или по две.

На контроллере Windows храните индивидуальные env в защищённом каталоге; не используйте общий доступ для всех сотрудников. Создайте C:\Deploy\nodes.csv (имена замените реальными):

```csv
Computer,EnvFile
UN-001,C:\Deploy\env\un-001.env
UN-002,C:\Deploy\env\un-002.env
UN-003,C:\Deploy\env\un-003.env
UN-004,C:\Deploy\env\un-004.env
UN-005,C:\Deploy\env\un-005.env
UN-006,C:\Deploy\env\un-006.env
UN-007,C:\Deploy\env\un-007.env
UN-008,C:\Deploy\env\un-008.env
UN-009,C:\Deploy\env\un-009.env
UN-010,C:\Deploy\env\un-010.env
```

Следующий цикл последовательно установит все десять, останавливаясь при первой ошибке. Предполагаются одинаковые административные учётные данные, порт 33001, каталог C:\script_factory и локальный robot на каждой УН. При различиях разбейте инвентарь на группы и измените команды для группы.

```powershell
$ErrorActionPreference='Stop'
$nodes=@(Import-Csv C:\Deploy\nodes.csv)
if($nodes.Count -ne 10){throw 'Ожидаются ровно десять УН'}
if(@($nodes.Computer | Select-Object -Unique).Count -ne 10){throw 'Повторяется имя УН'}
$expectedVersion = '0.13.1' # версия выбранного архива
$expectedSha256 = (Get-FileHash C:\Deploy\release.zip -Algorithm SHA256).Hash
# Архив должен содержать windows/deploy-one-un.ps1 из текущей версии проекта.
$tools = Join-Path $env:TEMP ('sf-deploy-tools-'+[guid]::NewGuid().ToString('N'))
Expand-Archive C:\Deploy\release.zip $tools
$credential=Get-Credential
foreach($node in $nodes){
$target=$node.Computer
$nodeEnv=$node.EnvFile
Write-Host "Начало установки: $target"
$session = New-PSSession -ComputerName $target -UseSSL -Credential $credential
try {
  Invoke-Command -Session $session -ScriptBlock {
    $p='C:\ProgramData\ScriptFactoryDeploy'
    New-Item $p -ItemType Directory -Force | Out-Null
    & icacls.exe $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Не удалось ограничить доступ'}

  }
  Copy-Item (Join-Path $tools 'windows\deploy-one-un.ps1') -Destination C:\ProgramData\ScriptFactoryDeploy\deploy-one-un.ps1 -ToSession $session
  Copy-Item (Join-Path $tools 'windows\deployment-state.ps1') -Destination C:\ProgramData\ScriptFactoryDeploy\deployment-state.ps1 -ToSession $session
  Copy-Item C:\Deploy\release.zip -Destination C:\ProgramData\ScriptFactoryDeploy\release.zip -ToSession $session
  Copy-Item $nodeEnv -Destination C:\ProgramData\ScriptFactoryDeploy\node.env -ToSession $session
  Invoke-Command -Session $session -ArgumentList $expectedVersion,$expectedSha256 -ScriptBlock {
    param($version,$sha256)
    & C:\ProgramData\ScriptFactoryDeploy\deploy-one-un.ps1 `
      -PackageZip C:\ProgramData\ScriptFactoryDeploy\release.zip `
      -ExpectedVersion $version -ExpectedSha256 $sha256 `
      -ProjectPath C:\script_factory `
      -EnvFile C:\ProgramData\ScriptFactoryDeploy\node.env `
      -Port 33001 -ConfirmNoNewJobs -ConfirmReplaceCode
    & C:\script_factory\windows\install-saby-task.ps1 -ProjectPath C:\script_factory
    Remove-Item C:\ProgramData\ScriptFactoryDeploy\node.env
    Invoke-RestMethod http://127.0.0.1:33001/live
  }
  Write-Host "Установка завершена: $target"
} catch {
  throw "Установка остановлена на адресе ${target}: $($_.Exception.Message)"
} finally { Remove-PSSession $session }
}
```

Перед запуском остановите поступление заданий из 1С и проверьте локальные изменения: флаги `ConfirmNoNewJobs` и `ConfirmReplaceCode` подтверждают именно это. Скрипт автоматически выбирает установку, обновление либо восстановление. Подробности и одиночный запуск — [проверка и восстановление установки](11-install-or-repair.md). У действующей установки сохраняется её `.env`; доставленный `node.env` используется только при отсутствии `.env`.

В списке должны быть разные физические УН: разные имена или IP могут указывать на одну машину. Ответ `/live` относится к текущей итерации; ошибка после него может относиться к следующей строке. Сообщения выше показывают адрес каждой итерации и имя целевого компьютера при отказе.

Замените порт, пути и пользователя, если они различаются. Цикл выполняет установку, но не заменяет итоговую приёмку десяти машин. После удаления node.env индивидуальная действующая конфигурация остаётся в C:\script_factory\.env. Не печатайте её в журнал.

`/live` подтверждает только API. `/health` и браузерное задание проверяйте после входа robot: удалённая административная сессия WinRM не является его рабочим столом. Не продолжайте массовую установку после первой необъяснённой ошибки.

## Подключить десять агентов

После обновления/установки API на всех десяти УН:

1. Разверните [центральный оркестратор](../project-guide/11-fleet-updates.md).
2. Зарегистрируйте десять уникальных UN_ID через панель либо `npm run fleet:enroll`.
3. Раздайте каждой УН её конфигурацию агента и общий публичный ключ подписи.
4. Установите `windows/install-fleet-agent.ps1`. Для массовой доставки предусмотрен `ansible/install-fleet-agent.yml`; он устанавливает только агент, а не Node/браузер/API.
5. Проверьте десять отдельных строк в панели: UN_ID, версия, последний контакт и готовность.

Дальнейшие обновления выполняйте по [инструкции для десяти УН](04-update-ten.md).
