# Отчёт по изменениям — релиз 0.6.0

**Коммит:** `ce1ada6` «feat: add system checks, job result mapping and callback auth hardening»
**Дата:** 18.09.2026 · **Объём:** 20 файлов, +1461/−158

## Ключевые изменения

1. **Ужесточена авторизация callback** — Bearer/Basic-заголовок, allowlist origin, запрет редиректов и inline-учётных данных.
2. **Новая структура `job.result`** под формат 1С: `artifacts` (массив строк-путей) + произвольные поля `Rezult_N`.
3. **Новый эндпоинт `GET /api/v2/system/ip-check`** — проверка внешнего IP машины УН против настроек IP-монитора.
4. **`/system/resources`** стал версионированным: добавлены `api_version`, `service_version`, `release_date`, `yandex_browser_version`; имена вложенных полей получили префиксы родителя.
5. Диагностика доставки callback: `response_history`, `last_response_*`, лимит тела ответа 16 КиБ, редактирование секретов.

---

## 1. `src/system-checks.js` (новый файл, 155 строк)

Экспортирует:

- `IP_MONITOR_SETTINGS_PATH` (src/system-checks.js:8) — путь по умолчанию `C:\_external ip monitor\settings.ini`.
- `IP_CHECK_URL` (src/system-checks.js:9) — по умолчанию `https://api.ipify.org?format=json`.
- `parseMonitorSettings(source)` (src/system-checks.js:25) — парсит INI: убирает BOM, пропускает пустые строки и комментарии `;`/`#`, распознаёт секции `[name]`, из секции `[main]` берёт ключ `ip_adress` (регистронезависимо). Требуется ровно один корректный адрес, иначе `IP_SETTINGS_INVALID`. IPv6 нормализуется через `URL.hostname`.
- `checkExternalIp(options)` (src/system-checks.js:45) — главная проверка:
  1. Читает settings.ini (`IP_MONITOR_SETTINGS_PATH` / env).
  2. Запрашивает внешний IP у ipify (JSON или plain text, тело ≤ 1 КиБ, редиректы запрещены).
  3. Общий `AbortController` с таймаутом, кап `IP_CHECK_TIMEOUT_MS = 3000`.
  4. Успех → `{ status: 'success' }` (HTTP 200); не совпал → `IP_MISMATCH` (503).

  Коды ошибок (все с HTTP 503, IP-адреса в сообщения не попадают):
  `IP_SETTINGS_READ_FAILED`, `IP_SETTINGS_INVALID`, `IP_LOOKUP_FAILED`, `IP_LOOKUP_INVALID`, `IP_MISMATCH`, `IP_CHECK_TIMEOUT`.
- `prefixResourceFields(value, prefix)` (src/system-checks.js:99) — рекурсивно добавляет префикс родительского ключа вложенным ключам (`cpu.system_percent` → `cpu.cpu_system_percent`); нужен для уникальности имён полей в `/system/resources`.
- `detectYandexVersion(options)` (src/system-checks.js:108) — определяет версию Яндекс Браузера:
  - **win32** — `reg.exe query HKCU/HKLM\Software\Yandex\YandexBrowser\BLBeacon /v version`;
  - **linux** — `--version` у `PUPPETEER_EXECUTABLE_PATH` и бинарников `/usr/bin/yandex-browser-stable`, `/usr/bin/yandex-browser`, `/opt/yandex/browser/yandex-browser`;
  - **darwin** — `PlistBuddy` по `CFBundleShortVersionString` из `/Applications/Yandex.app`.

  Каждый проб до 1000 мс, общий бюджет 2500 мс. Паттерны различают «Yandex Browser N» от «Chromium N» (версия Chromium не принимается). Не найдена → `null`.

Переменные окружения: `IP_MONITOR_SETTINGS_PATH`, `IP_CHECK_URL`, `PUPPETEER_EXECUTABLE_PATH`, `SystemRoot`.

## 2. `src/job-result.js` (новый файл, 13 строк)

`serializeJobResult(result)` — единая сериализация результата для API и callback:
- Из контекста (`result.context`, если он объект, иначе сам `result`) отбираются только ключи по шаблону `/^Rezult_[1-9]\d*$/` с объектными значениями.
- `artifacts` превращается в массив строк: из строк — строка, из объектов — поле `api_url`.
- Итог: `{ artifacts: [...], Rezult_1: {...}, ... }`.

## 3. `src/server.js` (+222 строк)

### Callback-авторизация и валидация URL (src/server.js:929–1017)

- Добавлены `CALLBACK_AUTH_USERNAME` / `CALLBACK_AUTH_PASSWORD` рядом с `CALLBACK_AUTH_TOKEN` (src/server.js:69–71).
- `buildCallbackAuthorization()` (src/server.js:960) — при старте формирует `CALLBACK_AUTHORIZATION`: `Bearer <token>` или `Basic <base64(username:password)>`. Запрещает: одновременно токен и Basic, частичный Basic, управляющие символы/двоеточие в логине, токен вне `[A-Za-z0-9\-._~+/]+=*`. При включённой авторизации без `CALLBACK_ALLOWED_ORIGINS` — падение при старте.
- `normalizeCallbackAllowedOrigin()` (src/server.js:950) — каждый origin из `CALLBACK_ALLOWED_ORIGINS` валидируется: только HTTPS без пути/параметров/учётных данных; HTTP допустим только для `127.0.0.1`/`[::1]`.
- `parseCallbackUrl(value)` (src/server.js:929) — строгая валидация `callback.url`: отклоняет некорректный URL, учётные данные в URL, пробелы/обратные слеши, auth-подобные параметры query (`username`, `password`, `token`, `api_key`, `access_token` и т.п.); требует HTTPS, кроме loopback `127.0.0.1`/`[::1]` (отсекаются обходы вида `http://localhost`, `http://127.1`, `http://2130706433`). Ошибки: `INVALID_CALLBACK` (400).
- `redactCallbackText(value, truncated)` (src/server.js:982) + `CALLBACK_REDACTION_VALUES` (src/server.js:78–97) — секреты (токен, логин, пароль, Basic-строка, их URI- и JSON-экранированные формы) заменяются на `[REDACTED]`; умеет редактировать секрет, «разрезанный» границей обрезки тела 16 КиБ.
- `validateCallbackOrigin()` (src/server.js:999) переписана поверх `parseCallbackUrl`: дополнительно отклоняет URL, содержащие настроенные секреты; сообщение `CALLBACK_ORIGIN_DENIED` больше не включает сам origin.
- `validateJobPayload` (src/server.js:1756): объект `callback` ограничен белым списком полей `url, max_attempts, backoff_ms, timeout_ms`; inline-логин/пароль через задание передавать нельзя.

### Доставка callback (src/server.js:1019–1119)

- `readCallbackResponseBody()` (src/server.js:1019) — читает тело ответа до лимита 16 КиБ (`CALLBACK_RESPONSE_BODY_MAX_BYTES`), помечает `body_truncated`, редактирует секреты.
- В `createJobRecord` (src/server.js:769–776) в `callback_delivery` добавлены: `last_response_at`, `last_response_content_type`, `last_response_body`, `last_response_body_truncated`, `response_history`.
- `deliverResultCallback()` (src/server.js:1053): `fetch` с `redirect: 'error'` (Authorization не пересылается на редирект), заголовок `Authorization`; детали каждой попытки (`attempt, received_at, http_status, content_type, body, body_truncated`) сохраняются в `response_history` и `last_*`; `last_http_status` заполняется и для не-2xx. В ошибку доставки добавлены `http_status`, `response_body`, `response_body_truncated`; текст ошибки и `callback_url` в логе проходят редакт. Коды ошибок: `CALLBACK_TIMEOUT`, `CALLBACK_DELIVERY_ERROR`.

### Результат задания

- `summarizeJob()` (src/server.js:790) — `result` теперь `serializeJobResult(job.result)` (src/server.js:808).
- `jobArtifactManifest(job)` (src/server.js:704) — внутренний доступ к полным объектам артефактов для скачивания файлов (`sendArtifactFile`, `/jobs/{id}/artifacts/{id}`).

### Системные эндпоинты

- `buildVersionedSystemResources()` (src/server.js:1629) — кэширует `detectYandexVersion()` на 60 с; добавляет `api_version: 'v2'`, `service_version`, `release_date`, `yandex_browser_version` и прогоняет всё через `prefixResourceFields` (`cpu.cpu_system_percent`, `queue.queue_running`, `browser_replay.*` и т.д.).
- `GET /api/v2/system/resources` (src/server.js:2169) — версионированный ответ.
- **Новый `GET /api/v2/system/ip-check`** (src/server.js:2174) — `Cache-Control: no-store`, отвечает `checkExternalIp()`. Health-эндпоинты не менялись и IP-проверки не делают.
- Демо-callback `/api/v2/demo/1c/callback` (src/server.js:1847–1857): новый query-параметр `?response_status=400..599` — отвечает кодом и телом `DEMO_CALLBACK_REJECTED` для воспроизведения 401/402.

## 4. `.env.example`

Убран заполненный `CALLBACK_AUTH_TOKEN=change-this-callback-token`. Добавлены три пустые переменные: `CALLBACK_AUTH_TOKEN=`, `CALLBACK_AUTH_USERNAME=`, `CALLBACK_AUTH_PASSWORD=`; `CALLBACK_ALLOWED_ORIGINS=` оставлен пустым.

## 5. UI: `public/app.js`, `public/queue.html`

- `renderArtifacts()` (public/app.js:213) — под новую структуру: `result.artifacts` — массив строк; карточки — ссылки на `api_url`, имя файла из пути, превью скриншотов и поле `kind` удалены.
- `renderResources()` (public/queue.html:413) — читает префиксные имена `cpu.cpu_system_percent`, `memory.memory_used_percent`, `queue.queue_running`, `queue.queue_max_parallel_jobs`.

## 6. Демо-сценарии

`demo/queue-case-lib.mjs:161` и `demo/stage4-parallel.mjs:64–66` адаптированы под префиксные имена полей.

## 7. `openapi.yaml` (version → 0.6.0)

- **`JobResult`** переписан: удалены `job_id`, `uid`, `un_id`, `message`, `steps_executed`, `duration_ms`, `context`, `Artifact[] items`, `simulated_outcome`, `runtime`; остались `required: [artifacts]` (массив строк) + `additionalProperties` для объектов `Rezult_N`.
- **`SystemResources`**: добавлены `api_version`, `service_version`, `release_date`, `yandex_browser_version` (nullable); вложенные поля переименованы с префиксом; `queue` инлайн с префиксными полями; добавлен блок `browser_replay.*`.
- **`callback_delivery`**: добавлены `last_response_at`, `last_response_content_type`, `last_response_body` (≤16 КиБ), `last_response_body_truncated`, `response_history[]`.
- Новый путь **`GET /system/ip-check`**: 200 `{status: success}` / 503 с enum кодов ошибок.

## 8. Тесты

- **test/callback-auth.test.js** (новый, 267 строк) — e2e через spawn сервера:
  - Basic/Bearer: заголовок доходит только до allowlisted получателя; секреты редактируются из `response_history`, ошибок, логов и snapshot в SQLite; повтор после 503 сохраняет обе попытки;
  - редирект (307) → падение доставки, целевой хост не запрашивается;
  - отклонение вредоносных URL (учётные данные в URL, auth-параметры query, HTTP-не-loopback, `localhost`, `127.1`, `2130706433`, `file:`, поддомены, другой порт) до создания задания;
  - отклонение inline-авторизации в `callback` (400, без утечки секретов);
  - лимит тела 16 КиБ и редат секрета, разрезанного границей обрезки;
  - падение старта при 11 некорректных комбинациях конфигурации auth/origins.
- **test/system-checks.test.js** (новый, 226 строк) — юнит-тесты парсера INI, `prefixResourceFields`, `detectYandexVersion` (linux/win32/darwin, отказ от «Chromium») и e2e `/system/ip-check`: все шесть кодов ошибок, отсутствие IP в ответах, `no-store`, 401 без ключа, независимость `/health`, метаданные версий и уникальность имён полей в `/system/resources`.
- **test/server.test.js**: env добавлен `CALLBACK_ALLOWED_ORIGINS=origin`; ассерты ресурсов на префиксные имена + версии; результат приведён к новой структуре; проверки `response_history`, `last_response_body*`; новый тест «страница 402» через `?response_status=402`.

## 9. Документация

- **docs/answers-1c-integration.md** — новый раздел «10. Ответы по вопросам "Демо 4 часть 2"»: `/system/ip-check` и коды ошибок; уровни логов; `min_level=warn`; версии и уникальные имена в `/system/resources`; авторизация callback Bearer/Basic; системные параметры vs `parameters.context`; новая структура `job.result`; файлы и логи; очередь и `timeout_ms`. Абзац про `response_history`/16 КиБ и Postman-коллекцию.
- **docs/stage-4-1c-integration.md** — описание `job.result` с примером `Rezult_1`, раздел авторизации callback, диагностика через `response_history`/`last_response_*`, упоминание `/system/ip-check`.
- **docs/versioning.md**, **docs/update-un-step-by-step.md** — примеры версий обновлены 0.4.0 → 0.5.0.
- **docs/postman/callback-402.postman_collection.json** (новый) — коллекция из двух запросов к HTTP-сервису 1С: неверный Bearer (ожидается 401) и валидный токен (ожидается 402), тела — события `job.completed`.

## 10. Версионирование

- `package.json`: 0.4.0 → **0.6.0**, `releaseDate` → «18.09.2026».
- `package-lock.json`: синхронно 0.6.0.
- `openapi.yaml`: `info.version` → 0.6.0.
- `pnpm-lock.yaml`: добавлен lockfile v9.

### Неточность, исправленная в 0.6.1

Примеры версий в `openapi.yaml` (схема `ServiceVersion`), `docs/versioning.md`, `docs/update-un-step-by-step.md` и `docs/answers-1c-integration.md` были обновлены только до **0.5.0**, тогда как фактический релиз — **0.6.0**. В релизе 0.6.1 примеры синхронизированы с актуальной версией (0.6.0) и датой релиза (18.09.2026).
