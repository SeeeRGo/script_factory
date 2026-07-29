# Script Factory

Stage 2 MVP for the distributed script execution service described in `plan-realizacii.md`. It includes the local priority queue, persistent jobs, a registry-driven JSON-steps interpreter, normalized execution errors, and a browser view of every scripting step.

## Start locally

```bash
cp .env.example .env
# Set WEB_LOGIN and WEB_PASSWORD in .env
npm start
```

Requires Node.js 24+.

The API listens on `http://localhost:3000`.
The Execution Studio is available at `http://localhost:3000/`.
Swagger UI is available at `http://localhost:3000/docs`.
The visual queue monitor is available at `http://localhost:3000/queue`.

The browser interface requires a login. Credentials are read from `WEB_LOGIN` and
`WEB_PASSWORD` in `.env`; the password is never sent back to the browser. A successful
login creates an HttpOnly session cookie that expires after 12 hours by default.

The Docker Compose Swagger UI helper is available at `http://localhost:33002`.
In `docker compose`, it loads the spec from a mounted local file and preloads `X-API-Key: dev-secret`.

## Docker

```bash
docker compose up --build
```

Перед запуском Docker Compose для демо выполните `npm run demo:reset`. Интерфейс
очереди будет доступен на `http://localhost:33001/queue`, Swagger — на
`http://localhost:33002`. Для запуска сценария из терминала задайте адрес API:

```bash
DEMO_API_URL=http://127.0.0.1:33001 npm run demo:success
```

State is persisted to `data/state.sqlite` locally and `/app/data/state.sqlite` in Docker.

## Execution Studio

Open `/` for a 12-minute guided demo with four ready-to-run scenarios: success, file-not-found, retry, and timeout. Each card includes presenter talking points and can either load its JSON into the editor or run immediately. The same editor supports creating a scenario from a clean template, previewing its step graph, starting it, and following live progress.

The view shows resolved step parameters, status, timing, attempts, normalized errors, recent jobs, and interpreter logs. It uses the same API key and same-origin API as the service, so it also works in the single Railway container.

The default `dev-secret` is prefilled for local development. For other environments, enter the configured `API_KEY`; it is stored only in the current browser's local storage.

## JSON interpreter

The interpreter validates scripts before they enter the queue. Each step supports:

- `id`: optional stable name used in logs and visualization;
- `action`: a registered action name;
- `params`: action parameters, including context expressions such as `{{root_dir}}` and `{{found_files}}`;
- `timeout_ms`: optional per-step timeout;
- `duration_ms`: mock adapter duration for Stage 2 demonstrations and tests.

Registered actions are `noop`, `check_ip`, `launch_browser`, `navigate`, `auth_ecp`, `find_files`, `upload_files`, `validate_report`, `submit_if_valid`, and `move_files`. `GET /api/v2/interpreter/actions` returns the runtime registry.

Exact context expressions preserve their JSON type, so `"{{found_files}}"` resolves to an array rather than a string. Step outputs are merged into the context for subsequent steps. The execution result returns the final context.

The normalized workflow errors are `IP_MISMATCH`, `FILE_NOT_FOUND`, `AUTH_ERROR`, `UPLOAD_ERROR`, `VALIDATION_ERROR`, `TIMEOUT_ERROR`, and `PLUGIN_NOT_RUNNING`.

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
# Укажите WEB_LOGIN и WEB_PASSWORD
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
