# Общие настройки .env и массовая замена

## Можно ли заранее заполнить постоянные параметры?

Да. Подготовьте корпоративный шаблон `.env` и используйте его для **новых** установок. Общими могут быть PORT, каталоги при одинаковой структуре дисков, тайм-ауты, callback origin, настройки браузера и политика питания. Для СБИС обычно MAX_PARALLEL_JOBS=1. Пример общих несекретных строк:

```dotenv
HOST=0.0.0.0
PORT=33001
DATA_DIR=C:/ScriptFactoryData
MAX_PARALLEL_JOBS=1
DEFAULT_JOB_TIMEOUT_MS=300000
JOB_RETENTION_DAYS=30
BROWSER_HEADLESS=false
BROWSER_PRODUCT=yandex
CALLBACK_ALLOWED_ORIGINS=https://dev.companya.ru
FILESYSTEM_ALLOWED_ROOTS=C:/отчеты;C:/Отчеты_загруженные;C:/Отчеты_с_ошибками;C:/ScriptFactoryData
POWER_MODE=shutdown
POWER_ENABLED=false
POWER_BACKGROUND_ENABLED=false
POWER_DRY_RUN=true
POWER_USER_IDLE_SECONDS=900
```

Это фрагмент, не полная конфигурация. Начните с windows/.env.example и замените в нём эти значения без дублирования ключей. Режим питания включайте отдельно после пилота. Во время первой установки EXECUTION_MODE оставьте inline, WORKER_ACCOUNT/WORKER_AUTH_TOKEN/WORKER_PORT — пустыми; install-task.ps1 настроит broker и создаст секрет.

Индивидуальны UN_ID, API_KEY, WEB_PASSWORD, учётная запись/пути при различиях машин. WORKER_AUTH_TOKEN создаётся отдельно для каждой УН. Секреты callback можно брать из общего защищённого хранилища, но нельзя публиковать в Git. В Git допустим отдельный **несекретный** корпоративный шаблон. Сам API автоматически не объединяет несколько env-файлов: до запуска должен получиться один полный env по фактическому EnvFile задачи.

## Изменить существующие десять УН

Первоначальная версия оркестратора распространяла только код. Начиная с 0.13.0 для согласованных профилей используйте модуль конфигураций из инструкции 09; приведённый ниже способ WinRM остаётся альтернативой для административной правки. Для конфигурации используйте согласованное административное средство: WinRM/PowerShell или систему управления конфигурацией. Не заменяйте существующий env целиком общим шаблоном: потеряются UN_ID, ключи, пути и локальный секрет worker.

Порядок:

1. Утвердить список УН и только изменяемые пары ключ–значение. Сначала применить к одной.
2. Приостановить постановку из всех клиентов 1С, дождаться пустой очереди и завершения callback. Сохранить политику питания и временно отключить фоновое выключение через API, если оно включено.
3. Сохранить защищённую копию env. Остановить задачи worker и API в согласованное окно; не менять ключевые настройки на выполняющемся задании.
4. Заменить только нужные строки. Не печатать полный env в вывод.
5. Запустить API, затем worker; проверить /health и фактически применённые настройки. После успеха вернуть приём заданий и политику питания. При ошибке вернуть backup и прежние задачи.

Ниже пример замены двух **несекретных** параметров на одной УН через уже настроенный WinRM HTTPS. После успешного пилота замените `$nodes` на `@(Import-Csv C:\Deploy\nodes.csv | ForEach-Object { $_.Computer })`, используя инвентарь из инструкции 02. Цикл остановится при первой ошибке. Команды остановки предполагают штатные имена задач и выполненные шаги 1–2:

```powershell
$ErrorActionPreference='Stop'
$changes = @{ BROWSER_STEP_DELAY_MS='350'; BROWSER_HOLD_OPEN_MS='5000' }
$nodes=@('UN-001') # сначала пилот; после приёмки — список десяти из nodes.csv
$credential=Get-Credential
foreach($target in $nodes){
Invoke-Command -ComputerName $target -UseSSL -Credential $credential -ArgumentList $changes -ScriptBlock {
  param($changes)
  $ErrorActionPreference='Stop'
  $p='C:\script_factory\.env' # фактический EnvFile
  $backupRoot='C:\ProgramData\ScriptFactoryConfigBackups'
  New-Item $backupRoot -ItemType Directory -Force | Out-Null
  & icacls.exe $backupRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Не удалось защитить backup'}
  $backup=Join-Path $backupRoot ((Get-Date -Format yyyyMMdd-HHmmss)+'-'+[guid]::NewGuid().ToString('N')+'.env')
  Copy-Item -LiteralPath $p -Destination $backup
  $acl=Get-Acl -LiteralPath $p
  $text=[IO.File]::ReadAllText($p)
  foreach($key in $changes.Keys){
    if($key -notin @('BROWSER_STEP_DELAY_MS','BROWSER_HOLD_OPEN_MS')){throw 'Ключ не разрешён этим примером'}
    $value=[string]$changes[$key]
    if($value -notmatch '^\d+$'){throw 'Ожидается число'}
    $pattern='(?m)^\s*'+[regex]::Escape($key)+'=.*$'
    if([regex]::IsMatch($text,$pattern)){$text=[regex]::Replace($text,$pattern,$key+'='+$value)}
    else{$text+="`r`n$key=$value"}
  }
  Disable-ScheduledTask -TaskName 'ScriptFactory-Test-UN-Worker' | Out-Null
  Disable-ScheduledTask -TaskName 'ScriptFactory-Test-UN' | Out-Null
  Stop-ScheduledTask -TaskName 'ScriptFactory-Test-UN-Worker'
  Stop-ScheduledTask -TaskName 'ScriptFactory-Test-UN'
  Start-Sleep -Seconds 3
  $remaining=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if($remaining.Count -gt 0){throw 'Процессы не остановились; конфигурация не изменена, задачи оставлены отключёнными'}
  [IO.File]::WriteAllText($p,$text,(New-Object Text.UTF8Encoding($false)))
  Set-Acl -LiteralPath $p -AclObject $acl
  Enable-ScheduledTask -TaskName 'ScriptFactory-Test-UN' | Out-Null
  Enable-ScheduledTask -TaskName 'ScriptFactory-Test-UN-Worker' | Out-Null
  Start-ScheduledTask -TaskName 'ScriptFactory-Test-UN'
  Start-ScheduledTask -TaskName 'ScriptFactory-Test-UN-Worker'
  @{updated=$true;backup=$backup}
}
}
```

Пример требует проверки на пилоте Windows. Если процесс не остановился вместе с задачей, не продолжайте замену/перезапуск: проверьте supervisor и точный PID по инструкции обновления. Не расширяйте белый список на PORT, DATA_DIR, WORKER_ACCOUNT, EXECUTION_MODE или секреты без отдельного плана: смена порта требует Firewall/проброса/адресов 1С, смена DATA_DIR — переноса данных, смена worker — задач и Saby. Для полностью автоматической массовой операции нужна проверка очереди, остановки и отката на каждой УН; этот пример не заменяет такой установщик. Если выполнение прервалось после отключения задач, проверьте backup/файл, восстановите его при необходимости и вручную включите задачи; не оставляйте УН с отключённым запуском.

## Почему значение после правки может остаться прежним

* Процессы читают env при запуске: перезапустить нужно API и worker.
* Переменные окружения, уже заданные ОС/процессу, имеют приоритет над env Node.js.
* max_parallel_jobs, default_job_timeout_ms, job_retention_days и retry_policy сохраняются в SQLite. На уже работающей установке меняйте их через `PUT /api/v2/system/config`, а не рассчитывайте только на новые env-defaults.
* Поля политики питания, явно изменённые через API, сохранены в DATA_DIR/power/config.json и имеют приоритет над POWER_* по каждому полю. Сверяйте `GET /api/v2/system/power/config`; для возврата питания к env см. [инструкцию модуля](../project-guide/09-power-management.md).
* browser и limits внутри JSON могут переопределять общие настройки. Подробности — [настройки браузера](../project-guide/10-browser-settings.md).

Для подготовки общего файла с индивидуальным UN_ID на новых УН предусмотрен [помощник профиля заказчика](08-customer-env-profile.md).

В API 0.13.0 добавлены [профили конфигураций, секреты, адреса УН и массовое применение](09-orchestrator-configurations.md). Для доставки конфигураций требуется обновление независимого агента до версии 2.
