# Как обновить Windows-УН вручную, без Ansible

Эта инструкция подходит для обновления одной или нескольких УН напрямую через
PowerShell. Проект на УН должен быть установлен как Git-репозиторий, например в
`C:\ScriptFactory`.

В примерах:

- `C:\ScriptFactory` — каталог установленного проекта;
- `ScriptFactory-Test-UN` — имя Scheduled Task;
- `un-001` — ожидаемый `UN_ID`;
- `f586f88a12bc` — точный номер Git-версии для установки.

Замените эти значения на свои. PowerShell нужно запустить от имени администратора.

## Что проверить перед обновлением

1. Уточните точный Git commit, который нужно установить. Не обновляйте УН просто до
   «последней версии», если номер версии не зафиксирован.
2. Временно остановите отправку новых заданий из 1С на эту УН.
3. Убедитесь, что worker-пользователь остаётся залогинен в Windows. Это нужно для
   видимого Яндекс Браузера.
4. Проверьте, что очередь пуста:

```powershell
$Health = Invoke-RestMethod 'http://127.0.0.1:33001/health'
$Health.queue
```

Продолжайте только при:

```text
running : 0
queued  : 0
```

Если задания ещё есть, дождитесь их завершения. Не останавливайте Scheduled Task во
время выполнения задания.

## Шаг 1. Задать параметры обновления

Откройте PowerShell от имени администратора и выполните:

```powershell
$ProjectPath = 'C:\ScriptFactory'
$TaskName = 'ScriptFactory-Test-UN'
$ExpectedUnId = 'un-001'
$NewVersion = 'f586f88a12bc'

Set-Location $ProjectPath
```

## Шаг 2. Проверить локальные изменения

```powershell
git status --short
```

Команда не должна выводить изменённые файлы проекта. `.env`, `data` и `work` обычно не
показываются, потому что они исключены из Git.

Если показаны изменения исходного кода, обновление остановите. Сначала нужно выяснить,
кто и зачем изменил эти файлы. Не удаляйте локальные изменения командами `reset` или
`checkout`.

## Шаг 3. Скачать нужную версию и запомнить текущую

```powershell
$OldVersion = (git rev-parse HEAD).Trim()
git fetch --tags origin
git rev-parse --verify "$NewVersion^{commit}"
```

Последняя команда должна вывести полный номер commit без ошибки.

Посмотрите сохранённые номера:

```powershell
"Текущая версия: $OldVersion"
"Новая версия:    $NewVersion"
```

Не закрывайте это окно PowerShell: переменная `$OldVersion` понадобится для отката.

## Шаг 4. Остановить worker и сделать резервную копию

Ещё раз убедитесь, что 1С не отправляет новые задания, затем выполните:

```powershell
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
    $TaskState = (Get-ScheduledTask -TaskName $TaskName).State
    if ($TaskState -ne 'Running') { break }
    Start-Sleep -Seconds 1
}
if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
    throw 'Scheduled Task не остановилась'
}

$BackupPath = "C:\ScriptFactory-backups\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $BackupPath | Out-Null
if (Test-Path "$ProjectPath\.env") {
    Copy-Item "$ProjectPath\.env" "$BackupPath\.env" -Force
}
if (Test-Path "$ProjectPath\data") {
    Copy-Item "$ProjectPath\data" "$BackupPath\data" -Recurse -Force
}

"Резервная копия: $BackupPath"
```

Каталог `work` обычно содержит рабочие документы и может быть большим, поэтому эта
команда его не копирует. Обновление Git его не удаляет и не изменяет.

## Шаг 5. Установить новую версию

```powershell
git checkout --detach $NewVersion
if ($LASTEXITCODE -ne 0) { throw 'Не удалось переключить Git-версию' }

$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm.cmd ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить npm-зависимости' }

& "$ProjectPath\windows\preflight.ps1" -ProjectPath $ProjectPath -Port 33001
if ($LASTEXITCODE -ne 0) { throw 'Preflight завершился с ошибкой' }
```

`.env`, `data` и `work` остаются на месте. Заново создавать `.env` или менять
`CALLBACK_ALLOWED_ORIGINS` для обычного обновления не нужно.

Если preflight показал ошибку, не запускайте новую версию. Перейдите сразу к разделу
«Как откатить обновление».

## Шаг 6. Запустить worker

```powershell
Start-ScheduledTask -TaskName $TaskName

$Health = $null
for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
    try {
        $Candidate = Invoke-RestMethod 'http://127.0.0.1:33001/health' -TimeoutSec 5
        if ($Candidate.ready -and $Candidate.un_id -eq $ExpectedUnId) {
            $Health = $Candidate
            break
        }
    } catch {
        # Worker ещё запускается. Следующая проверка будет через две секунды.
    }
    Start-Sleep -Seconds 2
}
if (-not $Health) { throw 'УН не стала готова за 60 секунд' }

$Health | ConvertTo-Json -Depth 8
```

Обновление считается успешным, если одновременно выполнены условия:

- HTTP-запрос выполнился без ошибки;
- `status` равен `ok`;
- `ready` равен `true`;
- `un_id` равен значению `$ExpectedUnId`;
- `checks.database.status`, `checks.filesystem.status` и `checks.browser.status` равны
  `ok`.

Можно выполнить короткую автоматическую проверку:

```powershell
if (-not $Health.ready) { throw 'УН не готова' }
if ($Health.un_id -ne $ExpectedUnId) { throw "Получен другой UN_ID: $($Health.un_id)" }
```

## Шаг 7. Выполнить тестовое задание

1. Откройте `http://IP_УН:33001/queue`.
2. Отправьте на УН одно безопасное тестовое задание из 1С.
3. Убедитесь, что задание завершилось со статусом `success`.
4. Проверьте получение результата или callback в 1С.

После успешной проверки снова разрешите 1С отправлять обычные задания на УН.

## Как откатить обновление

Если новая версия не запускается, `/health` не возвращает `ready=true` или тестовое
задание завершается ошибкой, выполните в том же окне PowerShell:

```powershell
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Set-Location $ProjectPath

git checkout --detach $OldVersion
if ($LASTEXITCODE -ne 0) { throw 'Не удалось вернуть прежнюю Git-версию' }

$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm.cmd ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'Не удалось восстановить npm-зависимости' }

Start-ScheduledTask -TaskName $TaskName

$RollbackHealth = $null
for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
    try {
        $Candidate = Invoke-RestMethod 'http://127.0.0.1:33001/health' -TimeoutSec 5
        if ($Candidate.ready -and $Candidate.un_id -eq $ExpectedUnId) {
            $RollbackHealth = $Candidate
            break
        }
    } catch {
        # Прежняя версия ещё запускается.
    }
    Start-Sleep -Seconds 2
}
if (-not $RollbackHealth) { throw 'Прежняя версия не стала готова за 60 секунд' }
$RollbackHealth | ConvertTo-Json -Depth 8
```

Старую версию можно считать восстановленной только после получения `ready=true` и
правильного `un_id`.

Резервная копия `.env` и `data` находится в `$BackupPath`. Не восстанавливайте SQLite
поверх рабочей базы без необходимости: сначала остановите worker и убедитесь, что после
обновления не появились новые задания или результаты.

## Как обновить несколько УН вручную

Повторите все шаги отдельно на каждой машине:

```text
остановить отправку из 1С → дождаться пустой очереди → обновить одну УН
→ проверить /health → выполнить тестовое задание → перейти к следующей УН
```

Не обновляйте все УН одновременно вручную. Сначала проверьте одну пилотную машину.

## Короткая памятка

```text
зафиксировать новую версию → остановить задания из 1С → дождаться пустой очереди
→ сохранить старую версию → остановить Scheduled Task → сделать резервную копию
→ git checkout новой версии → npm ci → preflight → запустить Scheduled Task
→ проверить /health → выполнить тест из 1С
```
