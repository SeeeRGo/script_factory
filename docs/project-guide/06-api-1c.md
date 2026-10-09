# Шпаргалка API и запуск из 1С

## 1. Адреса и авторизация

| Действие | Метод |
| --- | --- |
| Готовность / версия | GET /health, без ключа |
| Внешний IP | GET /api/v2/system/ip-check |
| Поставить задание | POST /api/v2/jobs |
| Получить результат | GET /api/v2/jobs/{job_id} |
| Найти по uid | GET /api/v2/jobs/by-uid/{uid} |
| Список заданий | GET /api/v2/jobs, массив items |
| Логи | GET /api/v2/jobs/{job_id}/logs |
| Отмена | POST /api/v2/jobs/{job_id}/cancel |
| Настройки | GET / PUT /api/v2/system/config |
| Каталог действий | GET /api/v2/interpreter/actions |

Используйте настоящий адрес/порт своей УН, например http://TEST_UN:33001. Для защищённых маршрутов нужен X-API-Key. Веб-логин и Windows-пароль не заменяют API_KEY.

## 2. Собрать запрос

Передайте script как объект или script_text как строку с полным JSON, не оба одновременно. Параметры задания можно передать на верхнем уровне либо в parameters; эти варианты нельзя смешивать.

Пример безопасного запроса:

```json
{
  "parameters": {
    "uid": "smoke-0001",
    "timeout_ms": 30000,
    "context": { "message": "Проверка из 1С" }
  },
  "script": {
    "format": "json-workflow",
    "steps": [
      { "action": "artifact_write", "params": { "filename": "check.txt", "text": "{{message}}" } },
      { "action": "compute", "params": { "expression": "({state:'completed'})" }, "save_as": "answer" }
    ],
    "output": { "Rezult_1": "{{answer}}" }
  }
}
```

Вместо script можно присвоить script_text строку, прочитанную из [smoke-workflow.json](examples/smoke-workflow.json). В 1С затем сериализуйте весь объект штатным JSON-сериализатором. Не экранируйте кавычки вручную и не сериализуйте строку сценария повторно перед присвоением.

Параметры контекста задания переопределяют script.context поверхностно. Повтор uid с тем же запросом возвращает старое задание (200), новый запрос — 201; прежний uid с другим содержимым — 409. Idempotency-Key можно передать заголовком; если одновременно указан uid, они должны совпадать.

Минимальная отправка из 1С после формирования ТелоJSON:

```bsl
Соединение = Новый HTTPСоединение("TEST_UN", 33001);
Запрос = Новый HTTPЗапрос("/api/v2/jobs");
Запрос.Заголовки.Вставить("X-API-Key", КлючAPI);
Запрос.Заголовки.Вставить("Content-Type", "application/json; charset=utf-8");
Запрос.УстановитьТелоИзСтроки(ТелоJSON, КодировкаТекста.UTF8,
    ИспользованиеByteOrderMark.НеИспользовать);
Ответ = Соединение.ВызватьHTTPМетод("POST", Запрос);
Если Ответ.КодСостояния <> 200 И Ответ.КодСостояния <> 201 Тогда
    ВызватьИсключение Ответ.ПолучитьТелоКакСтроку();
КонецЕсли;
```

Сохраните job.job_id из ответа. HTTP 201 — постановка, а не успешное выполнение. Через GET следите за job.status: success/failed/validation_failed/timeout/cancelled — конечные состояния; job.error объясняет сбой.

## 3. Проверить API из Windows PowerShell

Чтобы не помещать ключ в историю консоли, прочитайте API_KEY из конфигурации:

```powershell
$ProjectPath = 'C:\script_factory'
$EnvFile = Join-Path $ProjectPath '.env'
$entries = @([IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -match '^API_KEY=' })
$entry = $entries[0]
if (-not $entry) { throw 'Не задан API_KEY' }
$key = $entry.Substring(8).Trim().Trim('"').Trim("'")
$headers = @{ 'X-API-Key' = $key }
$base = 'http://127.0.0.1:33001'

$text = [IO.File]::ReadAllText("$ProjectPath\docs\project-guide\examples\smoke-workflow.json")
$request = @{ parameters = @{ uid = [guid]::NewGuid().ToString(); timeout_ms = 30000 }; script_text = $text }
$json = $request | ConvertTo-Json -Depth 50
$created = Invoke-RestMethod "$base/api/v2/jobs" -TimeoutSec 10 -Method Post -Headers $headers `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
$id = $created.job.job_id
```

Не сохраняйте JSON через Set-Content -Encoding UTF8 в PowerShell 5.1: он добавляет BOM, который JSON.parse запроса может отвергнуть. Выше передаются UTF-8 байты без BOM. Для файлов используйте `[IO.File]::WriteAllText($path,$json,(New-Object Text.UTF8Encoding($false)))`.

Затем:

```powershell
$job = (Invoke-RestMethod "$base/api/v2/jobs/$id" -TimeoutSec 10 -Headers $headers).job
$job | Select-Object job_id,status,error
$job.result.Rezult_1
$job.result.artifacts
```

Если ещё queued/running, повторите GET после паузы.

## 4. Результат и файлы

Публичный результат содержит artifacts и произвольные объектные Rezult_N:

```json
{
  "artifacts": [
    { "filename": "smoke-result.txt", "api_url": "/api/v2/jobs/JOB_ID/artifacts/ARTIFACT_ID" }
  ],
  "Rezult_1": { "state": "completed", "message": "Проверка из 1С" }
}
```

Начиная с 0.6.17 имя и расширение берите из filename, адрес скачивания — из api_url, добавив адрес УН. В GET списка, отдельного задания и callback формат одинаковый. Для старого URL-only состояния filename может быть null. Не используйте идентификатор артефакта как имя файла.

```powershell
$a = $job.result.artifacts[0]
Invoke-WebRequest ($base + $a.api_url) -TimeoutSec 10 -Headers $headers -UseBasicParsing `
  -OutFile (Join-Path $env:TEMP $a.filename)
```

Это пример для известного собственного smoke-артефакта. В универсальном клиенте нормализуйте входное filename до имени файла перед построением пути.

## 5. IP, callback и хранение

```powershell
Invoke-RestMethod "$base/api/v2/system/ip-check" -TimeoutSec 10 -Headers $headers
```

Успех: `{"status":"success","ip":"ФАКТИЧЕСКИЙ_IP"}`. Файл settings.ini сравнивается с адресом ipify; ошибка остаётся HTTP 503 с error.code/message. 1С может сравнить полученный ip между УН для поиска дубликатов. Это внешний IP, не адрес внутренней сети.

Callback задаётся как callback.url параметров задания и должен соответствовать CALLBACK_ALLOWED_ORIGINS. Токен берётся из .env УН, не из сценария. Callback сообщает состояние задания и результат; HTTP 2xx подтверждает доставку. Настройка и тест живого обработчика 1С описаны в [полном контракте](../stage-4-1c-integration.md). Не добавляйте рабочий callback в smoke-проверку обновления.

Завершённые задания, результаты, логи и артефакты удаляются автоматически после job_retention_days; по умолчанию 30 дней. Отдельно вызывать метод очистки из 1С не требуется. Настройка сохраняется в SQLite, поэтому изменение .env не обязательно заменяет уже сохранённое значение.

PUT /system/config меняет max_parallel_jobs, default_job_timeout_ms, job_retention_days и retry_policy (max_attempts/backoff_ms). Он не редактирует произвольные переменные .env, пути браузера, API_KEY или UI сценария. Для env-настроек нужен перезапуск worker.
