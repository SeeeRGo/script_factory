# Демонстрации универсального JSON workflow

С API 0.14.0 исполняемые демо-файлы, сценарии в веб-редакторе и генераторы заданий используют `format: "json-workflow"` — тот же исполнитель, что и полный сценарий СБИС. Учебные ошибки создаются `fail`/`assert`, а не имитаторами `auth_ecp`, `upload_files` или `validate_report` старого формата.

## Быстрая проверка

Подготовьте `.env`, запустите API и worker по основной инструкции. Для локальной разработки допускается inline-режим. Перед CLI укажите `DEMO_API_URL` (например `http://127.0.0.1:33001`) и `API_KEY`. Без DEMO_API_URL большинство CLI использует порт 3000; он должен совпадать с вашим API. Для файловых сценариев разрешите `demo-data` через FILESYSTEM_ALLOWED_ROOTS.

```powershell
$env:DEMO_API_URL = 'http://127.0.0.1:33001'
# API_KEY передайте из своего защищённого окружения.
npm run demo:success
npm run demo:error
npm run demo:retry
npm run demo:timeout
```

`demo/run.mjs` перед каждым запуском восстанавливает учебные файлы в `demo-data` и создаёт новый uid. В режиме удалённого API подготовьте учебные каталоги именно на УН и поправьте пути в context: локальное восстановление файлов CLI не копирует их на удалённую машину.

| Файл | Что выполняет | Ожидаемый результат |
| --- | --- | --- |
| success.json | files_list → фильтр префиксов → file_verify → file_copy → artifact_write | success; учебные XML скопированы в loaded_dir, отправки в ведомства нет |
| file-not-found.json | Поиск в пустом каталоге и assert | failed / FILE_NOT_FOUND, одна попытка |
| retry.json | Проверка системного attempt и fail только при attempt=1 | success на второй попытке, Rezult_1.attempt=2 |
| timeout.json | wait дольше тайм-аута шага | timeout, одна попытка |
| download-save-open.json | Браузерный fetch четырёх локальных HTTP-файлов, artifact_write, file_read, открытие документа и снимок | success; XML, JSON, CSV, TXT и PNG доступны в артефактах |
| download-save-open2.json | Загрузка и открытие HTML, затем fail | validation_failed / VALIDATION_ERROR; файл и снимки доступны в результате и callback |
| stage4-1c-delay.json | Ожидание из context.delay_ms, поиск TEST_ XML, копирование в архив | success и callback при настроенном получателе |

Файловые демо берут реальные байты с `/demo/files/` собственного API, поэтому не требуют внешних W3Schools/JSONPlaceholder/GitHub-ресурсов. Путь текущей попытки передаётся в системном `artifact_dir`. Перед отправкой из 1С задайте свой uid и callback; CLI удаляет пример callback, если DEMO_CALLBACK_URL не задан.

## Очередь и параллельность

```powershell
npm run demo:queue
npm run demo:queue:priority-error
npm run demo:queue:running-low
npm run demo:stage4:parallel
```

Сценарии очереди используют универсальные wait и fail. В priority-error P10 выбирается раньше P50, выполняет две попытки и завершается контролируемой PLUGIN_NOT_RUNNING. В running-low задание P10 ждёт освобождения единственного слота, не прерывая текущую попытку P50. Код PLUGIN_NOT_RUNNING здесь — выбранная в JSON учебная ошибка, а не проверка настоящего плагина.

## Браузерные сценарии и Recorder

`browser-replay-send-email.json`, `browser-replay-yandex-search.json` и `sbis-upload-stub.json` теперь содержат workflow: browser_launch и browser_steps. Исходные записи DevTools сохранены рядом в `*.recorder.json` только как входные примеры для обучения/конвертации. `recorder-conversion-source.json` также остаётся исходной записью; `recorder-conversion-workflow.json` — исполняемый вариант.

Yahoo-демо создаёт реальную отправку письма: используйте собственные согласованные реквизиты/получателя. Пароль не зашит в JSON; существующая настройка YAHOO_MAIL_PASSWORD остаётся на API/worker. Проверки проекта используют локальные браузерные страницы и не отправляют настоящие письма или отчёты.

Заглушка СБИС не подписывает и не отправляет отчёт; условия её запуска описаны в [sbis-upload-stub.md](sbis-upload-stub.md). Полный рабочий сценарий — [sbis-report-full.md](sbis-report-full.md).

## Повторы

И тестовые, и рабочие задания подчиняются одной [retry_policy](../docs/operator-guide/13-retry-policy.md). `max_attempts` включает первоначальное исполнение, `backoff_ms` задаёт паузу. API повторяет весь сценарий при ошибке, а не отдельный шаг. `retryable` в ошибках исполнения больше не используется. Отмена и срок текущей попытки останавливают задание.
