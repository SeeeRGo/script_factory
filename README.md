# Script Factory

Minimal MVP API for the distributed script execution service described in `plan-realizacii.md`.

## Start locally

```bash
npm start
```

Requires Node.js 24+.

The API listens on `http://localhost:3000`.
Swagger UI is available at `http://localhost:3000/docs`.

The Docker Compose Swagger UI helper is available at `http://localhost:3002`.
In `docker compose`, it loads the spec from a mounted local file and preloads `X-API-Key: dev-secret`.

## Docker

```bash
docker compose up --build
```

State is persisted to `data/state.sqlite` locally and `/app/data/state.sqlite` in Docker.

## Railway

Railway does not support Dockerfile `VOLUME` declarations. Persist state by adding a
Railway Volume to the service and setting its mount path to `/app/data`.

Set these Railway variables:

```text
API_KEY=<production-secret>
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

## Main routes

- `GET /openapi.yaml`
- `GET /docs`
- `GET /health`
- `GET /api/v2/health`
- `POST /api/v2/jobs`
- `GET /api/v2/jobs`
- `GET /api/v2/jobs/{job_id}`
- `POST /api/v2/jobs/{job_id}/cancel`
- `GET /api/v2/jobs/{job_id}/logs`
- `GET /api/v2/system/resources`
- `GET /api/v2/system/config`
- `PUT /api/v2/system/config`
