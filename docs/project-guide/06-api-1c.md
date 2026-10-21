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

Сохраните job.job_id из ответа. HTTP 201 — постановка, а не успешное выполнение. Для ручной проверки в 1С можно сохранить этот уже выданный job_id в своей записи задания и выполнять GET результата. Самостоятельно назначить серверный job_id при POST нельзя; для своего идентификатора предназначен uid.

Через GET следите за job.status: success/failed/validation_failed/timeout/cancelled — конечные состояния; job.error объясняет сбой.

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

Каталог на УН: `DATA_DIR/artifacts/JOB_ID`. Он появляется, когда сценарий создал артефакт; система не создаёт JSON результата для каждого произвольного сценария автоматически. Полный сценарий СБИС 3.0.0 явно сохраняет `result-N.json`. Если таких файлов несколько, используйте последний по порядку artifacts. Даже failed может содержать частичный результат: проверяйте `job.status`, `job.error`, `Rezult_1.state` и флаги подтверждения, а не только наличие файла. Скачивайте по api_url с X-API-Key, не по local_path.

Это пример для известного собственного smoke-артефакта. В универсальном клиенте нормализуйте входное filename до имени файла перед построением пути.

### Разобрать ошибку СБИС

Новый JSON 2.0.3 возвращает при подтверждённой блокировке лицензией:

```json
{
  "status": "failed",
  "error": {
    "code": "REPORTING_LICENSE_REQUIRED",
    "message": "СБИС блокирует отправку: отсутствует лицензия Отчетность",
    "retryable": false
  },
  "result": { "Rezult_1": { "state": "license_required" } }
}
```

Это фрагмент объекта `job`, а не полный HTTP-ответ. В 1С показывайте `job.error.message`, сохраняйте `code` и `Rezult_1.state`. `license_required` означает, что сценарий подтвердил текущую карточку и её неотправленный статус; архивирование не выполняется. Старые диагностические задания сохраняют прежние результаты и не получают новый код задним числом.

`requires_reconciliation` означает отсутствие однозначного подтверждения отправки. Не создавайте повторное задание отправки автоматически: сначала сверяйте карточку в СБИС. `validated_not_sent` — положительная проверка без отправки, `sent` — подтверждённая отправка по настроенному UI-профилю. Успех проверки не является квитанцией ведомства.

Пример чтения результата в 1С (иллюстрация для адаптации к своей конфигурации; в реальной 1С не запускался):

```bsl
Запрос = Новый HTTPЗапрос("/api/v2/jobs/" + ИдентификаторЗадания);
Запрос.Заголовки.Вставить("X-API-Key", КлючAPI);
Ответ = Соединение.ВызватьHTTPМетод("GET", Запрос);
Если Ответ.КодСостояния <> 200 Тогда
    ВызватьИсключение Ответ.ПолучитьТелоКакСтроку();
КонецЕсли;
Чтение = Новый ЧтениеJSON;
Чтение.УстановитьСтроку(Ответ.ПолучитьТелоКакСтроку());
Данные = ПрочитатьJSON(Чтение, Истина);
Чтение.Закрыть();
Задание = Данные.Получить("job");
Ошибка = Задание.Получить("error");
Если Ошибка <> Неопределено И Ошибка <> Null Тогда
    Сообщить(Ошибка.Получить("code") + ": " + Ошибка.Получить("message"));
КонецЕсли;
Результат = Задание.Получить("result");
// result может отсутствовать у незавершённого или рано упавшего задания.
Если Результат <> Неопределено И Результат <> Null Тогда
    Для Каждого Элемент Из Результат Цикл
        Если Лев(Элемент.Ключ, 7) = "Rezult_" Тогда
            ИтогОтчета = Элемент.Значение;
            // Унифицированная обработка отдельного отчета:
            // file_name, inn, section_name, state, validation_result и другие поля.
        КонецЕсли;
    КонецЦикла;
    Артефакты = Результат.Получить("artifacts");
КонецЕсли;
```

## 5. IP, callback и хранение

```powershell
Invoke-RestMethod "$base/api/v2/system/ip-check" -TimeoutSec 10 -Headers $headers
```

Успех: `{"status":"success","ip":"ФАКТИЧЕСКИЙ_IP"}`. Файл settings.ini сравнивается с адресом ipify. Начиная с API 0.9.0 при корректном, но несовпавшем IP вызывается резервный https://api.2ip.io; совпадение второго адреса даёт тот же успешный ответ. В ip возвращается адрес сервиса, подтвердившего совпадение. Если второй адрес тоже не совпал, возвращается HTTP 503 IP_MISMATCH; ошибка или тайм-аут второго ресурса дают соответствующий IP_LOOKUP_FAILED/IP_LOOKUP_INVALID/IP_CHECK_TIMEOUT. При ошибке первого ресурса переключение не выполняется. Каждый этап ограничен 3 секундами; для клиента оставьте тайм-аут не менее 10 секунд. В .env можно изменить IP_CHECK_URL и IP_CHECK_FALLBACK_URL; после изменения нужен перезапуск API. 1С может сравнить полученный ip между УН для поиска дубликатов. Это внешний IP, не адрес внутренней сети.

Callback задаётся как callback.url параметров задания и должен соответствовать CALLBACK_ALLOWED_ORIGINS. В API 0.9.2+ клиент может выбрать HTTP или HTTPS для домена либо IP, включая адрес во внутренней сети. В .env укажите origin без пути, например `CALLBACK_ALLOWED_ORIGINS=http://1c-server:8080`, а в задании — полный адрес `http://1c-server:8080/script-factory/result`. Разрешённые адреса разделяются запятыми; после изменения .env перезапустите задачу API. Токен берётся из .env УН, не из сценария. Callback сообщает состояние задания и результат; HTTP 2xx подтверждает доставку. Настройка и тест живого обработчика 1С описаны в [полном контракте](../stage-4-1c-integration.md). Не добавляйте рабочий callback в smoke-проверку обновления.

Обработчик 1С должен принимать также failed, сохранять результат по job_id и отвечать 2xx после успешного приёма. Повторная доставка callback не означает повторное исполнение задания; обработка должна быть идемпотентной. Сбой доставки исправляйте на стороне обработчика/доставки, не повторной отправкой отчёта. [Локальный стенд](08-local-stand.md) проверяет этот контракт с учебным HTTP-получателем, а не с настоящей 1С.

Завершённые задания, результаты, логи и артефакты удаляются автоматически после job_retention_days; по умолчанию 30 дней. Отдельно вызывать метод очистки из 1С не требуется. Настройка сохраняется в SQLite, поэтому изменение .env не обязательно заменяет уже сохранённое значение.

PUT /system/config меняет max_parallel_jobs, default_job_timeout_ms, job_retention_days и retry_policy (max_attempts/backoff_ms). Он не редактирует произвольные переменные .env, пути браузера, API_KEY или UI сценария. Для env-настроек нужен перезапуск worker.


## 6. Финансовое подтверждение и подтверждение приёма

JSON 2.0.3 различает REPORTING_LICENSE_REQUIRED (нет подходящей лицензии), REPORTING_LICENSE_CONFIRMATION_REQUIRED (требуется отдельное решение о «В долг») и LICENSE_PRICE_CHANGED (цена не совпала с согласованной). Последние два возвращают Rezult_1.state=license_confirmation_required; license_amount/license_currency в соответствующем Rezult_N показывают прочитанную цену, когда она распознана. Автоповтора нет. Boolean license_debt_enabled и числовая license_debt_expected_amount передаются в context только после отдельного согласования финансовых условий.

В сценарии 3.0.0 Rezult_N.state=sent относится только к конкретному XML; report_state=archived подтверждает его архивирование. Rezult_N.sbis_status содержит фактический статус: «Отчет отправлен, но еще не считается сданным» или «Отчет сдан». Наличие протокола внутренней проверки не заменяет квитанцию ведомства. Отдельное диагностическое задание reconcile_and_archive может только сверять уже выполненные отправки и архивировать рабочие копии; оно не отправляет отчёты повторно.

## 6. Плоские результаты СБИС 3.0.0

Контракт изменён с 14.10.2026, нужен API 0.6.21+. На каждый выбранный самостоятельный XML возвращается отдельный Rezult_N. Номер сохраняется внутри задания по порядку выбора файлов: порядок authority_prefixes и prefixes с исключением повторно выбранного пути. Номер не является постоянным идентификатором отчета между заданиями.

Все значения в Rezult_N скалярные: строки, числа, Boolean или null. Коллекций и вложенных структур внутри них нет. Системный artifacts остаётся рядом с результатами.

```json
{
  "artifacts": [],
  "Rezult_1": {
    "state": "sent",
    "report_state": "archived",
    "inn": "ВАШ_ИНН",
    "authority": "FNS",
    "section_name": "ФНС",
    "file_name": "FNS_TEST_ONLY.xml",
    "sbis_status": "Отчет сдан",
    "error_code": null
  },
  "Rezult_2": {
    "state": "license_required",
    "report_state": "validated",
    "inn": "ВАШ_ИНН",
    "authority": "SFR",
    "section_name": "СФР",
    "file_name": "SFR_TEST_ONLY.xml",
    "sbis_status": "Отправка заблокирована: нет лицензии",
    "error_code": "REPORTING_LICENSE_REQUIRED"
  }
}
```

Это сокращённый пример объекта job.result, а не полный HTTP-ответ. В полном результате дополнительно есть mode, sha256, load_datetime, validation_result, validation_protocol, archived_path, file_selection_verified, report_key_verified, error_message и плоские финансовые поля license_requires_confirmation, license_amount, license_currency, license_continuation.

section_name содержит имя подтверждённого раздела загрузки: ФНС, СФР или Росстат. До подтверждения импорта оно null; запланированный код ведомства всегда доступен в authority. Готовность реального отчета Росстата этим форматом не подтверждается.

При ошибке следующие отчеты имеют not_processed; уже отправленные сохраняют sent, даже если job.status=failed. Не отправляйте их повторно. Неподтверждённая отправка остаётся requires_reconciliation. Ошибка архива может сопровождать state=sent и report_state=sent: сначала исправьте архивирование, не повторяйте отправку. Если выбор XML не завершился, результатов может не быть; причина в job.error.

result-N.json содержит объект всех Rezult_N без массива reports. Последний такой артефакт соответствует финализации. API, артефакт и callback используют одинаковые отдельные структуры. Сохранённые задания версии 2.0.3 остаются со старым форматом.

Номер в имени `result-N.json` обозначает очередную финализацию результата, а не номер отчета: `result-2.json` может содержать все Rezult_N задания.

## Управление спящим режимом УН

С API 0.7.0 доступен POST /api/v2/system/power/suspend с пустым JSON-объектом. Ответ 202 подтверждает только принятие вызова, а не переход в сон; job_id, Rezult_N и callback для этого метода не создаются. Очередь, пользователи и порог бездействия проверяются после ответа. Настройки сохраняются на УН через PATCH /api/v2/system/power/config. Подробности: [спящий режим и массовое внедрение](09-power-management.md).


Начиная с версии 3.4.0 сценарий СБИС возвращает текст ошибок внутренней проверки в Rezult_N.error_message. Это одна строка, допускающая переводы строк; в ней сохраняются названия разделов, описания и пояснения СБИС. Полный текст также сохраняется в TXT по validation_protocol и доступен среди result.artifacts. При нескольких отчётах описание относится только к своему Rezult_N. В job.error.message собраны описания всех отчётов с ошибками. Callback содержит те же error и result, что GET /api/v2/jobs/{job_id}; это не квитанция ведомства. Старые задания сохраняют прежние результаты.


## Порядок полей отчёта

JSON-сценарий 3.5.0 формирует одинаковую последовательность общих полей каждого `Rezult_N` для ФНС, СФР и Росстата, при успехе и при ошибках:

```text
state, report_state, inn, authority, section_name, mode,
file_name, sha256, load_datetime, validation_result,
file_selection_verified, report_key_verified, validation_protocol,
sbis_status, archived_path, error_path, error_protocol_path,
error_code, error_message, license_requires_confirmation,
license_amount, license_currency, license_continuation,
file_count, bundle_verified
```

Затем идут `file_name_1, sha256_1, error_path_1`, затем те же поля для 2 и далее до `file_count`. Неприменимые значения общих полей всегда присутствуют как null либо false. Порядок сохранён в экспортируемом JSON; по стандарту JSON ключи объекта не упорядочены, поэтому в 1С надёжнее обращаться по именам, а не по позициям.

После ошибки проверки XML перемещаются в `context.error_dir` (по умолчанию `C:/Отчеты_с_ошибками`; при явном null — в `loaded_dir`), статус остаётся `validation_failed`. `error_path`, `error_protocol_path` и `error_path_N` показывают фактическое расположение файлов; `validation_protocol` остаётся ссылкой на скачиваемый API-артефакт. При сбое переноса смотрите также `job.error` и `Rezult_N.error_code/error_message`.
