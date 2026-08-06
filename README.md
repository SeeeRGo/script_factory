# Script Factory · Stage 3

Stage 3 of the distributed script execution service described in `plan-realizacii.md`.
The service accepts native Chrome DevTools Recorder JSON, validates it with
`@puppeteer/replay`, executes it in real Chromium through the persistent priority queue,
and exposes step-by-step progress, logs, identifiers, and screenshot artifacts. The
Stage 2 JSON-steps interpreter remains backward compatible.

Документация этапа 3:

- [как записывать и передавать новые браузерные сценарии](docs/script-creation.md);
- [готовый 15-минутный план демонстрации](docs/demo-stage-3.md);
- [живой показ Chromium через SSH и noVNC](docs/novnc-demo.md);
- [два многозаданных кейса приоритетной очереди](docs/demo-queue-cases.md);
- [реальная отправка Yahoo → Gmail](demo/browser-replay-send-email.json);
- [поиск в Яндексе и переход по первой ссылке](demo/browser-replay-yandex-search.json).

## Start locally

```bash
cp .env.example .env
# Set UN_ID, WEB_LOGIN, WEB_PASSWORD and YAHOO_MAIL_PASSWORD in .env
npm install
npm start
```

Requires Node.js 24+.

Install dependencies once with `npm install`. Chromium must be available locally;
set `PUPPETEER_EXECUTABLE_PATH` if it is outside a standard system path. The Docker
image installs Chromium automatically.

The API listens on `http://localhost:3000`.
The Execution Studio is available at `http://localhost:3000/`.
Swagger UI is available at `http://localhost:3000/docs`.
The visual queue monitor is available at `http://localhost:3000/queue`.

The browser interface requires a login. Credentials are read from `WEB_LOGIN` and
`WEB_PASSWORD` in `.env`; the password is never sent back to the browser. A successful
login creates an HttpOnly session cookie that expires after 12 hours by default.
`UN_ID` identifies the machine in healthchecks, jobs, and execution results.

The Docker Compose Swagger UI helper is available at `http://localhost:33002`.
In `docker compose`, it loads the spec from a mounted local file and preloads `X-API-Key: dev-secret`.

## Docker

```bash
docker compose up --build
```

Docker Compose включает presenter mode: Chromium работает в Xvfb, а встроенный noVNC
открывается на главной странице через авторизованный same-origin proxy. Внутренний сервис
работает на порту `33303`, но отдельно открывать его для iframe не требуется. Для прямого
доступа только через SSH пробросьте порты приложения и noVNC:

```bash
ssh -N -L 33001:127.0.0.1:33001 user@server
```

Затем откройте `http://127.0.0.1:33001` и ссылку «Экран Chromium». Полная настройка,
режим внешнего порта и меры безопасности описаны в
[`docs/novnc-demo.md`](docs/novnc-demo.md).

Перед запуском Docker Compose для демо выполните `npm run demo:reset`. Интерфейс
очереди будет доступен на `http://localhost:33001/queue`, Swagger — на
`http://localhost:33002`. Для запуска сценария из терминала задайте адрес API:

```bash
DEMO_API_URL=http://127.0.0.1:33001 npm run demo:success
```

State is persisted to `data/state.sqlite` locally and `/app/data/state.sqlite` in Docker.

## Execution Studio

Open `/` for a Stage 3 guided demo. The first ready-to-run scenario performs 20 real
browser steps: it logs into `seeergo@yahoo.com`, composes a message for
`10sydneyfc@gmail.com`, sends it, verifies Yahoo's success notification, and returns a
screenshot. The second browser scenario searches Yandex and opens the first organic
result. On the first login, the Yahoo flow also handles the `guce.yahoo.com` and
`consent.yahoo.com` screens and dismisses optional Mail onboarding. Stage 2 diagnostic
scenarios remain available. Yahoo credentials are read only
from `.env`; `YAHOO_MAIL_PASSWORD` is never placed in the scenario JSON.

The view shows resolved step parameters, status, timing, attempts, normalized errors, recent jobs, and interpreter logs. It uses the same API key and same-origin API as the service, so it also works in the single Railway container.

The default `dev-secret` is prefilled for local development. For other environments, enter the configured `API_KEY`; it is stored only in the current browser's local storage.

## JSON interpreter

The interpreter validates scripts before they enter the queue. Each step supports:

- `id`: optional stable name used in logs and visualization;
- `title`: short human-readable step name shown in the execution flow;
- `description`: explanation of the action and its expected effect;
- `action`: a registered action name;
- `params`: action parameters, including context expressions such as `{{root_dir}}` and `{{found_files}}`;
- `timeout_ms`: optional per-step timeout;
- `duration_ms`: mock adapter duration for Stage 2 demonstrations and tests.

Registered actions are `noop`, `check_ip`, `launch_browser`, `navigate`, `auth_ecp`, `find_files`, `upload_files`, `download_files`, `validate_report`, `submit_if_valid`, and `move_files`. `GET /api/v2/interpreter/actions` returns the runtime registry.

Exact context expressions preserve their JSON type, so `"{{found_files}}"` resolves to an array rather than a string. Step outputs are merged into the context for subsequent steps. The execution result returns the final context.

Downloaded files are returned in `result.artifacts` with `artifact_id`, `filename`,
`local_path`, source URL, content type, size, and checksum metadata. Every successful
result also includes `job_id`, `uid`, and `un_id`.

The normalized workflow errors are `IP_MISMATCH`, `FILE_NOT_FOUND`, `AUTH_ERROR`,
`UPLOAD_ERROR`, `DOWNLOAD_ERROR`, `VALIDATION_ERROR`, `TIMEOUT_ERROR`,
`PLUGIN_NOT_RUNNING`, `BROWSER_LAUNCH_ERROR`, and `BROWSER_REPLAY_ERROR`.
SmartCaptcha Яндекса возвращает отдельный `CAPTCHA_REQUIRED`. В headed/noVNC-режиме
исполнитель сначала ждёт ручное подтверждение в течение `BROWSER_CAPTCHA_WAIT_MS`; в
headless-режиме ошибка возвращается немедленно, без ожидания обычного тайм-аута шага.

Example:

```json
{
  "context": {
    "root_dir": "/reports/incoming",
    "loaded_dir": "/reports/loaded"
  },
  "script": {
    "steps": [
      {
        "action": "find_files",
        "params": {
          "directory": "{{root_dir}}",
          "files": ["FNS_2026.xml"]
        }
      },
      {
        "action": "upload_files",
        "params": { "files": "{{found_files}}" }
      },
      {
        "action": "move_files",
        "params": {
          "files": "{{found_files}}",
          "destination": "{{loaded_dir}}"
        }
      }
    ]
  }
}
```

## Tests

```bash
npm test
```

The suite covers the step contract and registry, typed parameter substitution, successful context flow, required error codes, per-step timeout, API validation, exposed execution state, logs, and root UI serving.

## Railway

Railway does not support Dockerfile `VOLUME` declarations. Persist state by adding a
Railway Volume to the service and setting its mount path to `/app/data`.

Set these Railway variables:

```text
API_KEY=<production-secret>
UN_ID=<stable-machine-identifier>
WEB_LOGIN=<interface-login>
WEB_PASSWORD=<strong-interface-password>
WEB_COOKIE_SECURE=true
DATA_DIR=/app/data
HOST=0.0.0.0
```

Do not set `PORT`; Railway injects it at runtime and the app already reads
`process.env.PORT`.

Swagger UI is served by the app at `/docs`.

## Auth

All `/api/v2/*` routes require `X-API-Key: dev-secret` by default.

Set `API_KEY` to override the default.
Swagger UI in `docker compose` preauthorizes the default dev key for convenience.
`POST /api/v2/jobs` accepts an optional `Idempotency-Key` header. If omitted, the server generates `uid` automatically and returns it in the job response.

## Демо этапа 2: JSON-steps Interpreter

Демо показывает исполнение цепочки JSON-шагов, передачу результатов через контекст,
подробные логи, нормализованные ошибки, retry и тайм-аут шага. Браузерные действия
на этом этапе работают в mock-режиме; `find_files` и `move_files` используют реальную
локальную файловую систему.

Подготовка и запуск:

```bash
cp .env.example .env
# Укажите UN_ID, WEB_LOGIN и WEB_PASSWORD
npm run demo:reset
npm start
```

Откройте в браузере:

- `http://localhost:3000/` — основной 12-минутный маршрут, готовые сценарии и редактор;
- `http://localhost:3000/queue` — визуальная очередь с автообновлением;
- `http://localhost:3000/docs` — Swagger UI с готовыми примерами запросов.

Для подключения используется API-ключ `dev-secret`. В Swagger нажмите
«Авторизация», а в мониторе очереди ключ уже подставлен для локального демо.

В другом терминале можно запустить каждый сценарий отдельно:

```bash
npm run demo:success
npm run demo:error
npm run demo:retry
npm run demo:timeout
```

Чтобы отдельно показать FIFO-очередь с приоритетами и анимированным прогрессом:

```bash
npm run demo:queue
```

Команда фиксирует `max_parallel_jobs = 1` и создаёт четыре задания. Первое начинает
выполняться сразу, остальные сортируются по приоритету: `P10 → P30 → P50`.

Для двух согласованных кейсов с несколькими JSON-заданиями и контролируемыми ошибками:

```bash
npm run demo:queue:priority-error
npm run demo:queue:running-low
```

Первый кейс одновременно показывает P10 и P50 в очереди, затем запускает P10 первым и
завершает его ошибкой. Во втором P10 поступает во время активного P50 и ждёт освобождения
слота: очередь невытесняющая. Полный маршрут показа описан в
[`docs/demo-queue-cases.md`](docs/demo-queue-cases.md).

Или выполнить полный прогон:

```bash
npm run demo:all
```

Сценарии автоматически восстанавливают файлы в `demo-data`, создают задание,
показывают смену статусов и выводят журнал. Для ручного запуска через Swagger перед
успешным сценарием выполните `npm run demo:reset` и задайте новый `Idempotency-Key`.

Рекомендуемый порядок показа:

1. Открыть `/queue` и `/docs` в соседних вкладках.
2. Выполнить `npm run demo:queue`, показать порядок приоритетов и движение карточек.
3. Запустить пример `success`, показать прогресс шагов и открыть его логи.
4. Запустить `fileNotFound`, показать `FILE_NOT_FOUND` и остановку цепочки.
5. Запустить `retry`, показать переход `running → retrying → running → success`.
6. При наличии времени запустить `timeout` и показать `TIMEOUT_ERROR`.

## Main routes

- `GET /openapi.yaml`
- `GET /docs`
- `GET /` (Execution Studio)
- `GET /queue` (визуальная очередь)
- `GET /health`
- `GET /api/v2/health`
- `POST /api/v2/jobs`
- `GET /api/v2/jobs`
- `GET /api/v2/jobs/{job_id}`
- `POST /api/v2/jobs/{job_id}/cancel`
- `GET /api/v2/jobs/{job_id}/logs`
- `GET /api/v2/interpreter/actions`
- `GET /api/v2/system/resources`
- `GET /api/v2/system/config`
- `PUT /api/v2/system/config`
