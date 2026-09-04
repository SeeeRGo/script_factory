import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, statfsSync } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import {
  abortableDelay,
  createDefaultStepRegistry,
  executeScript,
  isPuppeteerReplayScript,
  validateScript
} from './interpreter.js';
import {
  executeBrowserReplay,
  openFileInBrowser,
  resolveBrowserExecutablePath
} from './browser-replay.js';
import { createDemoMail } from './demo-mail.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || 'dev-secret';
const WEB_LOGIN = process.env.WEB_LOGIN;
const WEB_PASSWORD = process.env.WEB_PASSWORD;
const UN_ID = process.env.UN_ID;
const DEMO_MAIL_LOGIN = process.env.DEMO_MAIL_LOGIN || 'demo.user';
const DEMO_MAIL_PASSWORD = process.env.DEMO_MAIL_PASSWORD || 'demo-password';
const YAHOO_MAIL_URL = process.env.YAHOO_MAIL_URL || 'https://login.yahoo.com/?src=ym&activity=header-signin';
const YAHOO_MAIL_LOGIN = process.env.YAHOO_MAIL_LOGIN || 'seeergo@yahoo.com';
const YAHOO_MAIL_PASSWORD = process.env.YAHOO_MAIL_PASSWORD || '';
const YAHOO_MAIL_RECIPIENT = process.env.YAHOO_MAIL_RECIPIENT || '10sydneyfc@gmail.com';
const configuredSessionHours = Number(process.env.WEB_SESSION_TTL_HOURS || 12);
const WEB_SESSION_TTL_SECONDS = Number.isFinite(configuredSessionHours)
  ? Math.floor(Math.max(60, configuredSessionHours * 60 * 60))
  : 12 * 60 * 60;
const WEB_COOKIE_SECURE = process.env.WEB_COOKIE_SECURE === 'true';
const WEB_SESSION_COOKIE = 'script_factory_session';
const BASE_PATH = '/api/v2';
const MAX_BODY_SIZE = 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const STATE_FILE = path.join(DATA_DIR, 'state.sqlite');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const OPENAPI_FILE = path.join(process.cwd(), 'openapi.yaml');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const DEMO_DOWNLOAD_DIR = path.join(process.cwd(), 'demo', 'fixtures');
const DEMO_DOWNLOAD_FILES = new Map([
  ['stage4-download-demo.html', 'text/html; charset=utf-8'],
  ['stage4-report.xml', 'application/xml; charset=utf-8'],
  ['stage4-result.json', 'application/json; charset=utf-8'],
  ['stage4-register.csv', 'text/csv; charset=utf-8'],
  ['stage4-log.txt', 'text/plain; charset=utf-8']
]);
const SWAGGER_LOCALIZATION_FILE = path.join(process.cwd(), 'swagger-ru.js');
const NOVNC_PROXY_PREFIX = '/browser-live';
const NOVNC_INTERNAL_PORT = Number(process.env.NOVNC_INTERNAL_PORT || 33303);
const PERSIST_DEBOUNCE_MS = Number(process.env.PERSIST_DEBOUNCE_MS || 50);
const CALLBACK_AUTH_TOKEN = process.env.CALLBACK_AUTH_TOKEN || '';
const DEMO_1C_CALLBACK_ENABLED = process.env.DEMO_1C_CALLBACK_ENABLED === 'true';
const CALLBACK_ALLOWED_ORIGINS = String(process.env.CALLBACK_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const FILESYSTEM_ALLOWED_ROOTS = String(process.env.FILESYSTEM_ALLOWED_ROOTS || '')
  .split(path.delimiter)
  .map((root) => root.trim())
  .filter(Boolean);
const CORS_ALLOWED_HEADERS = 'X-API-Key, Idempotency-Key, Content-Type, Accept, Origin, Authorization';
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';
const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const LOG_LEVEL_PRIORITY = new Map(LOG_LEVELS.map((level, index) => [level, index]));
const webSessions = new Map();
const demoMail = createDemoMail({ login: DEMO_MAIL_LOGIN, password: DEMO_MAIL_PASSWORD });

const state = {
  startedAt: Date.now(),
  config: {
    max_parallel_jobs: Number(process.env.MAX_PARALLEL_JOBS || 1),
    default_job_timeout_ms: Number(process.env.DEFAULT_JOB_TIMEOUT_MS || 30000),
    retry_policy: {
      max_attempts: Number(process.env.RETRY_MAX_ATTEMPTS || 2),
      backoff_ms: Number(process.env.RETRY_BACKOFF_MS || 500)
    }
  },
  jobs: new Map(),
  queue: [],
  running: new Set(),
  controllers: new Map(),
  callbackTimers: new Map(),
  demoCallbackEvents: [],
  demoCallbackFailures: new Set(),
  activeCount: 0
};

const STEP_ALLOWED_ROOTS = [
  ...(FILESYSTEM_ALLOWED_ROOTS.length > 0 ? FILESYSTEM_ALLOWED_ROOTS : [process.cwd(), DATA_DIR]),
  ARTIFACTS_DIR
];
const stepRegistry = createDefaultStepRegistry({ allowedRoots: STEP_ALLOWED_ROOTS });

let previousCpuSample = { usage: process.cpuUsage(), time: process.hrtime.bigint() };
let previousSystemCpuSample = os.cpus().map((cpu) => ({ ...cpu.times }));

let persistTimer = null;
let persistRequested = false;
let db = null;

function nowIso() {
  return new Date().toISOString();
}

function validateRuntimeConfig() {
  if (!WEB_LOGIN || !WEB_PASSWORD || !UN_ID) {
    throw new Error('WEB_LOGIN, WEB_PASSWORD и UN_ID должны быть заданы в .env или переменных окружения');
  }
}

function secureTextEqual(provided, expected) {
  const providedBuffer = Buffer.from(String(provided ?? ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected ?? ''), 'utf8');
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return [part, ''];
      const value = part.slice(separator + 1);
      try {
        return [part.slice(0, separator), decodeURIComponent(value)];
      } catch {
        return [part.slice(0, separator), ''];
      }
    }));
}

function sessionToken(req) {
  return parseCookies(req)[WEB_SESSION_COOKIE];
}

function isWebAuthenticated(req) {
  const token = sessionToken(req);
  if (!token) return false;
  const session = webSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    webSessions.delete(token);
    return false;
  }
  return true;
}

function createWebSession() {
  const now = Date.now();
  for (const [token, session] of webSessions) {
    if (session.expiresAt <= now) webSessions.delete(token);
  }
  const token = randomBytes(32).toString('base64url');
  webSessions.set(token, { expiresAt: now + WEB_SESSION_TTL_SECONDS * 1000 });
  return token;
}

function sessionCookie(token, maxAge = WEB_SESSION_TTL_SECONDS) {
  return [
    `${WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(WEB_COOKIE_SECURE ? ['Secure'] : [])
  ].join('; ');
}

function redirect(res, location) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store'
  });
  res.end();
}

function requireWebAuth(req, res, requestUrl) {
  if (isWebAuthenticated(req)) return true;
  const next = encodeURIComponent(`${requestUrl.pathname}${requestUrl.search}`);
  redirect(res, `/login?next=${next}`);
  return false;
}

function noVncProxyPath(requestUrl) {
  const pathname = requestUrl.pathname.slice(NOVNC_PROXY_PREFIX.length) || '/';
  return `${pathname}${requestUrl.search}`;
}

function proxyNoVncHttp(req, res, requestUrl) {
  const proxyRequest = http.request({
    hostname: '127.0.0.1',
    port: NOVNC_INTERNAL_PORT,
    method: req.method,
    path: noVncProxyPath(requestUrl),
    headers: { ...req.headers, host: `127.0.0.1:${NOVNC_INTERNAL_PORT}` }
  }, (proxyResponse) => {
    res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    proxyResponse.pipe(res);
  });
  proxyRequest.on('error', (error) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { code: 'NOVNC_UNAVAILABLE', message: `Экран Chromium недоступен: ${error.message}` }
      });
    } else {
      res.destroy(error);
    }
  });
  req.pipe(proxyRequest);
}

function rejectUpgrade(socket, statusCode, statusMessage) {
  socket.end(`HTTP/1.1 ${statusCode} ${statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function writeUpgradeResponse(socket, response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}`];
  for (const [name, rawValue] of Object.entries(response.headers)) {
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (value !== undefined) lines.push(`${name}: ${value}`);
    }
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function defaultConfig() {
  return {
    max_parallel_jobs: Number(process.env.MAX_PARALLEL_JOBS || 1),
    default_job_timeout_ms: Number(process.env.DEFAULT_JOB_TIMEOUT_MS || 30000),
    retry_policy: {
      max_attempts: Number(process.env.RETRY_MAX_ATTEMPTS || 2),
      backoff_ms: Number(process.env.RETRY_BACKOFF_MS || 500)
    }
  };
}

function openDatabase() {
  if (db) return db;

  db = new DatabaseSync(STATE_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return db;
}

function buildJobSnapshot(job) {
  return {
    job_id: job.job_id,
    uid: job.uid,
    request_hash: job.request_hash,
    log_level: job.log_level,
    status: job.status,
    priority: job.priority,
    request: job.request,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    timeout_ms: job.timeout_ms,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    result: job.result,
    error: job.error,
    callback_delivery: job.callback_delivery,
    cancellation_requested: job.cancellation_requested,
    execution: job.execution,
    logs: job.logs
  };
}

function restoreJob(snapshot) {
  const job = {
    job_id: snapshot.job_id,
    uid: snapshot.uid,
    request_hash: snapshot.request_hash ?? null,
    log_level: LOG_LEVEL_PRIORITY.has(snapshot.log_level) ? snapshot.log_level : 'info',
    status: snapshot.status,
    priority: Number.isFinite(snapshot.priority) ? snapshot.priority : 100,
    request: snapshot.request && typeof snapshot.request === 'object' ? snapshot.request : {},
    attempts: Number.isFinite(snapshot.attempts) ? snapshot.attempts : 0,
    max_attempts: Number.isFinite(snapshot.max_attempts) ? snapshot.max_attempts : state.config.retry_policy.max_attempts,
    timeout_ms: Number.isFinite(snapshot.timeout_ms) ? snapshot.timeout_ms : state.config.default_job_timeout_ms,
    created_at: snapshot.created_at || nowIso(),
    updated_at: snapshot.updated_at || nowIso(),
    started_at: snapshot.started_at || null,
    finished_at: snapshot.finished_at || null,
    result: snapshot.result ?? null,
    error: snapshot.error ?? null,
    callback_delivery: snapshot.callback_delivery ?? null,
    cancellation_requested: Boolean(snapshot.cancellation_requested),
    execution: restoreExecution(snapshot.execution, snapshot.request?.script),
    logs: Array.isArray(snapshot.logs) ? snapshot.logs : []
  };

  if (job.status === 'running' || job.status === 'retrying') {
    job.status = 'queued';
    job.error = null;
    job.cancellation_requested = false;
    job.finished_at = null;
    job.execution = createExecution(job.request.script);
  }

  return job;
}

function serializeState() {
  const jobs = [...state.jobs.values()].map(buildJobSnapshot);
  return {
    version: 1,
    saved_at: nowIso(),
    config: state.config,
    jobs
  };
}

async function loadPersistedState() {
  await mkdir(DATA_DIR, { recursive: true });
  openDatabase();

  const configRow = db.prepare('SELECT config_json FROM app_config WHERE id = 1').get();
  const jobRows = db.prepare('SELECT snapshot_json FROM jobs').all();
  if (configRow?.config_json || jobRows.length > 0) {
    if (configRow?.config_json) {
      const parsedConfig = JSON.parse(configRow.config_json);
      state.config = {
        ...defaultConfig(),
        ...parsedConfig,
        retry_policy: {
          ...defaultConfig().retry_policy,
          ...(parsedConfig.retry_policy || {})
        }
      };
    } else {
      state.config = defaultConfig();
    }

    state.jobs.clear();
    for (const row of jobRows) {
      const snapshot = JSON.parse(row.snapshot_json);
      const job = restoreJob(snapshot);
      state.jobs.set(job.job_id, job);
    }
    rebuildQueueFromJobs();
    return;
  }

  const legacyExists = await readLegacyJsonState();
  if (legacyExists) {
    persistRequested = true;
    flushPersistence();
    return;
  }

  state.config = defaultConfig();
  state.jobs.clear();
  rebuildQueueFromJobs();
}

async function readLegacyJsonState() {
  try {
    const raw = await readFile(LEGACY_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.config && typeof parsed.config === 'object') {
      state.config = {
        ...defaultConfig(),
        ...parsed.config,
        retry_policy: {
          ...defaultConfig().retry_policy,
          ...(parsed.config.retry_policy || {})
        }
      };
    }

    state.jobs.clear();
    const restoredJobs = Array.isArray(parsed?.jobs) ? parsed.jobs.map(restoreJob) : [];
    for (const job of restoredJobs) {
      state.jobs.set(job.job_id, job);
    }
    rebuildQueueFromJobs();
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw createApiError('PERSISTENCE_LOAD_FAILED', `Не удалось загрузить прежнее состояние: ${error.message}`, 500, false);
  }
}

function rebuildQueueFromJobs() {
  state.queue = [...state.jobs.values()]
    .filter((job) => job.status === 'queued')
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.created_at.localeCompare(b.created_at);
    })
    .map((job) => job.job_id);
  state.running.clear();
  state.controllers.clear();
  state.activeCount = 0;
}

function createExecution(script = {}) {
  const steps = Array.isArray(script.steps) ? script.steps : [];
  return {
    status: 'pending',
    total_steps: steps.length,
    completed_steps: 0,
    current_step: null,
    percent: steps.length === 0 ? 0 : 0,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    context: null,
    steps: steps.map((step, index) => ({
      index,
      id: step.id ?? `step_${index + 1}`,
      action: step.action ?? step.type ?? 'unknown',
      title: step.title ?? null,
      description: step.description ?? null,
      status: 'pending',
      attempt: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      params: null,
      output: null,
      error: null
    }))
  };
}

function restoreExecution(execution, script) {
  const expected = createExecution(script);
  if (!execution || typeof execution !== 'object' || !Array.isArray(execution.steps)) return expected;
  return {
    ...expected,
    ...execution,
    steps: expected.steps.map((step, index) => ({ ...step, ...(execution.steps[index] ?? {}) }))
  };
}

function schedulePersist() {
  persistRequested = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      flushPersistence();
    } catch (error) {
      console.error('Failed to persist SQLite state:', error);
    }
  }, PERSIST_DEBOUNCE_MS);
}

function flushPersistence() {
  if (!persistRequested || !db) {
    return;
  }

  persistRequested = false;
  const snapshot = serializeState();
  const insertConfig = db.prepare(`
    INSERT INTO app_config (id, config_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);
  const upsertJob = db.prepare(`
    INSERT INTO jobs (job_id, uid, snapshot_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      uid = excluded.uid,
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `);

  try {
    db.exec('BEGIN IMMEDIATE');
    insertConfig.run(JSON.stringify(snapshot.config), nowIso());
    for (const job of snapshot.jobs) {
      upsertJob.run(job.job_id, job.uid, JSON.stringify(job), job.updated_at);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendSwaggerUi(res) {
  const body = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Документация API «Фабрика сценариев»</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
      body {
        margin: 0;
        background: #fff;
      }
      .auth-bar {
        min-height: 44px;
        padding: 0 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #d8dde3;
        background: #f7f8fa;
        font: 13px system-ui, sans-serif;
      }
      .auth-bar a { color: #17211c; }
      .auth-bar form { margin: 0; }
      .auth-bar button {
        border: 0;
        background: none;
        color: #69736d;
        cursor: pointer;
        font: inherit;
      }
    </style>
  </head>
  <body>
    <div class="auth-bar">
      <a href="/">← Фабрика сценариев</a>
      <form action="/auth/logout" method="post"><button type="submit">Выйти</button></form>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="/swagger-ru.js"></script>
    <script>
      window.installSwaggerRu();
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function sendOpenApiYaml(res) {
  const yaml = await readFile(OPENAPI_FILE, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/yaml; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(yaml);
}

async function sendSwaggerLocalization(res) {
  const script = await readFile(SWAGGER_LOCALIZATION_FILE, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(script)
  });
  res.end(script);
}

async function sendPublicFile(res, filename) {
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  const safeName = path.basename(filename);
  const file = path.join(PUBLIC_DIR, safeName);
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': contentTypes[path.extname(safeName)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': safeName.endsWith('.html') ? 'no-cache' : 'public, max-age=300'
  });
  res.end(body);
}

async function sendDemoDownloadFile(res, filename) {
  const contentType = DEMO_DOWNLOAD_FILES.get(filename);
  if (!contentType) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Демо-файл не найден' } });
    return;
  }
  const body = await readFile(path.join(DEMO_DOWNLOAD_DIR, filename));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function sendJobArtifactFile(res, job, artifact) {
  const filename = path.basename(artifact?.filename || 'artifact');
  const artifactRoot = path.resolve(ARTIFACTS_DIR);
  const localPath = artifact?.local_path ? path.resolve(artifact.local_path) : null;
  if (!artifact || !localPath || !localPath.startsWith(`${artifactRoot}${path.sep}`)) {
    sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'Артефакт не найден' } });
    return;
  }
  try {
    const body = await readFile(localPath);
    res.writeHead(200, {
      'Content-Type': artifact.mime_type || 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': `inline; filename="${filename.replaceAll('"', '')}"`,
      'Cache-Control': 'private, max-age=300'
    });
    res.end(body);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'Файл артефакта отсутствует на УН' } });
      return;
    }
    throw error;
  }
}

async function sendArtifactFile(res, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'artifacts') {
    sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'Артефакт не найден' } });
    return;
  }
  const [, jobId, encodedFilename] = parts;
  const filename = path.basename(decodeURIComponent(encodedFilename));
  const job = state.jobs.get(jobId);
  const artifact = job?.result?.artifacts?.find((item) => item.filename === filename);
  await sendJobArtifactFile(res, job, artifact);
}

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '600');
}

function logJob(job, level, message, details = undefined) {
  const configuredLevel = LOG_LEVEL_PRIORITY.has(job.log_level) ? job.log_level : 'info';
  const eventPriority = LOG_LEVEL_PRIORITY.get(level) ?? LOG_LEVEL_PRIORITY.get('info');
  if (eventPriority >= LOG_LEVEL_PRIORITY.get(configuredLevel)) {
    job.logs.push({
      ts: nowIso(),
      level,
      message,
      ...(details === undefined ? {} : { details })
    });
  }
  job.updated_at = nowIso();
  schedulePersist();
}

function createJobRecord(payload, requestHash) {
  const callback = payload.callback;
  const job = {
    job_id: `job_${randomUUID()}`,
    uid: payload.uid,
    request_hash: requestHash,
    log_level: payload.log_level ?? 'info',
    status: 'queued',
    priority: Number.isFinite(payload.priority) ? payload.priority : 100,
    request: payload,
    attempts: 0,
    max_attempts: Number.isFinite(payload.retry_policy?.max_attempts)
      ? payload.retry_policy.max_attempts
      : state.config.retry_policy.max_attempts,
    timeout_ms: Number.isFinite(payload.timeout_ms)
      ? payload.timeout_ms
      : state.config.default_job_timeout_ms,
    created_at: nowIso(),
    updated_at: nowIso(),
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
    callback_delivery: callback ? {
      status: 'pending',
      url: callback.url,
      attempts: 0,
      max_attempts: callback.max_attempts ?? 5,
      last_http_status: null,
      next_retry_at: null,
      delivered_at: null,
      error: null
    } : null,
    cancellation_requested: false,
    execution: createExecution(payload.script),
    logs: []
  };

  logJob(job, 'info', 'Задание создано', { uid: job.uid, un_id: UN_ID, priority: job.priority });
  return job;
}

function summarizeJob(job) {
  return {
    job_id: job.job_id,
    uid: job.uid,
    un_id: UN_ID,
    log_level: job.log_level,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    backoff_ms: job.request.retry_policy?.backoff_ms ?? state.config.retry_policy.backoff_ms,
    timeout_ms: job.timeout_ms,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    callback_delivery: job.callback_delivery,
    result: job.result,
    execution: job.execution
  };
}

function exposeArtifacts(jobId, artifacts) {
  return artifacts.map((artifact) => ({
    ...artifact,
    api_url: `${BASE_PATH}/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}`
  }));
}

function sortQueue() {
  state.queue.sort((aId, bId) => {
    const a = state.jobs.get(aId);
    const b = state.jobs.get(bId);
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.created_at.localeCompare(b.created_at);
  });
}

function enqueue(job) {
  state.queue.push(job.job_id);
  sortQueue();
}

function removeFromQueue(jobId) {
  const index = state.queue.indexOf(jobId);
  if (index >= 0) state.queue.splice(index, 1);
}

function createApiError(code, message, statusCode = 400, retryable = false, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  error.details = details;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function parseScriptText(scriptText) {
  if (typeof scriptText !== 'string' || !scriptText.trim()) {
    throw createApiError('INVALID_PAYLOAD', 'Поле script_text должно быть непустой JSON-строкой', 400, false);
  }
  try {
    const script = JSON.parse(scriptText);
    if (!script || typeof script !== 'object' || Array.isArray(script)) {
      throw new TypeError('Сценарий должен быть JSON-объектом');
    }
    return script;
  } catch (error) {
    throw createApiError('INVALID_SCRIPT_TEXT', `Не удалось разобрать script_text: ${error.message}`, 400, false);
  }
}

function normalizeJobCreatePayload(rawPayload) {
  if (rawPayload.parameters !== undefined
    && (!rawPayload.parameters || typeof rawPayload.parameters !== 'object' || Array.isArray(rawPayload.parameters))) {
    throw createApiError('INVALID_PAYLOAD', 'Поле parameters должно быть JSON-объектом', 400, false);
  }

  const parameterNames = ['uid', 'priority', 'timeout_ms', 'retry_policy', 'context', 'callback', 'log_level'];
  if (rawPayload.parameters) {
    const mixedFields = parameterNames.filter((name) => rawPayload[name] !== undefined);
    if (mixedFields.length > 0) {
      throw createApiError(
        'INVALID_PAYLOAD',
        `Параметры задания нельзя одновременно передавать на верхнем уровне и в parameters: ${mixedFields.join(', ')}`,
        400,
        false
      );
    }
  }

  if (rawPayload.script_text !== undefined && rawPayload.script !== undefined) {
    throw createApiError('INVALID_PAYLOAD', 'Передайте только одно из полей: script или script_text', 400, false);
  }

  const payload = rawPayload.parameters ? { ...rawPayload.parameters } : { ...rawPayload };
  const scriptSource = rawPayload.script_text !== undefined ? parseScriptText(rawPayload.script_text) : rawPayload.script;
  delete payload.parameters;
  delete payload.script_text;
  if (scriptSource !== undefined) payload.script = scriptSource;
  return payload;
}

function isRetryableError(error) {
  return Boolean(error?.retryable);
}

function serializeJobError(error) {
  return {
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || 'Непредвиденная ошибка выполнения',
    retryable: Boolean(error?.retryable),
    ...(Number.isInteger(error?.step_index) ? { step_index: error.step_index } : {}),
    ...(typeof error?.action === 'string' ? { action: error.action } : {}),
    ...(error?.details === undefined ? {} : { details: error.details })
  };
}

const TERMINAL_JOB_STATUSES = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);

function validateCallbackOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createApiError('INVALID_CALLBACK', 'callback.url должен использовать http или https', 400, false);
  }
  if (CALLBACK_ALLOWED_ORIGINS.length > 0 && !CALLBACK_ALLOWED_ORIGINS.includes(url.origin)) {
    throw createApiError('CALLBACK_ORIGIN_DENIED', `Адрес callback не входит в CALLBACK_ALLOWED_ORIGINS: ${url.origin}`, 400, false);
  }
  return url;
}

function callbackEvent(job) {
  return {
    event_id: `${job.job_id}:${job.status}:${job.finished_at}`,
    event: 'job.completed',
    occurred_at: job.finished_at,
    job: summarizeJob(job)
  };
}

async function deliverResultCallback(job) {
  const delivery = job.callback_delivery;
  if (!delivery || delivery.status === 'delivered' || !TERMINAL_JOB_STATUSES.has(job.status)) return;
  if (delivery.attempts >= delivery.max_attempts) return;

  delivery.status = 'delivering';
  delivery.attempts += 1;
  delivery.next_retry_at = null;
  delivery.error = null;
  logJob(job, 'info', 'Отправка результата в 1С', {
    callback_url: delivery.url,
    callback_attempt: delivery.attempts,
    callback_max_attempts: delivery.max_attempts
  });

  const callback = job.request.callback;
  const controller = new AbortController();
  const timeoutMs = callback.timeout_ms ?? 5000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(validateCallbackOrigin(delivery.url), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Script-Factory-Event': 'job.completed',
        'Idempotency-Key': `${job.job_id}:${job.status}:${job.finished_at}`,
        ...(CALLBACK_AUTH_TOKEN ? { Authorization: `Bearer ${CALLBACK_AUTH_TOKEN}` } : {})
      },
      body: JSON.stringify(callbackEvent(job))
    });
    delivery.last_http_status = response.status;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    delivery.status = 'delivered';
    delivery.delivered_at = nowIso();
    logJob(job, 'info', 'Результат доставлен в 1С', {
      callback_attempt: delivery.attempts,
      http_status: response.status
    });
  } catch (error) {
    delivery.error = {
      code: error?.name === 'AbortError' ? 'CALLBACK_TIMEOUT' : 'CALLBACK_DELIVERY_ERROR',
      message: error?.name === 'AbortError'
        ? `Callback не ответил за ${timeoutMs} мс`
        : error?.message || 'Ошибка доставки результата'
    };
    if (delivery.attempts >= delivery.max_attempts) {
      delivery.status = 'failed';
      logJob(job, 'error', 'Не удалось доставить результат в 1С', delivery.error);
    } else {
      delivery.status = 'retrying';
      const backoffMs = Math.min(
        (callback.backoff_ms ?? 1000) * (2 ** (delivery.attempts - 1)),
        60_000
      );
      delivery.next_retry_at = new Date(Date.now() + backoffMs).toISOString();
      logJob(job, 'warn', 'Callback результата будет повторён', {
        ...delivery.error,
        backoff_ms: backoffMs
      });
      scheduleResultCallback(job, backoffMs);
    }
  } finally {
    clearTimeout(timeout);
    schedulePersist();
  }
}

function scheduleResultCallback(job, delayMs = 0) {
  if (!job.callback_delivery || !TERMINAL_JOB_STATUSES.has(job.status)) return;
  if (job.callback_delivery.status === 'delivered' || job.callback_delivery.attempts >= job.callback_delivery.max_attempts) return;
  if (state.callbackTimers.has(job.job_id)) clearTimeout(state.callbackTimers.get(job.job_id));
  const timer = setTimeout(() => {
    state.callbackTimers.delete(job.job_id);
    void deliverResultCallback(job);
  }, Math.max(0, delayMs));
  timer.unref?.();
  state.callbackTimers.set(job.job_id, timer);
}

function applyInterpreterEvent(job, event) {
  const execution = job.execution;
  if (event.type === 'script_started') {
    execution.status = 'running';
    execution.started_at = event.ts;
    execution.finished_at = null;
    execution.duration_ms = null;
    execution.context = null;
    execution.current_step = null;
    execution.completed_steps = 0;
    execution.percent = 0;
    execution.steps.forEach((step) => Object.assign(step, {
      status: 'pending',
      attempt: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      params: null,
      output: null,
      error: null
    }));
    return;
  }

  if (event.type.startsWith('step_')) {
    const step = execution.steps[event.step_index];
    if (!step) return;
    execution.current_step = event.step_index;
    if (event.type === 'step_started') {
      Object.assign(step, {
        status: 'running',
        attempt: job.attempts,
        started_at: event.ts,
        finished_at: null,
        params: event.params,
        output: null,
        error: null
      });
      logJob(job, 'info', `Шаг ${event.step_index + 1}/${execution.total_steps} запущен`, {
        action: event.action,
        step_id: event.step_id,
        params: event.params
      });
    } else if (event.type === 'step_completed') {
      Object.assign(step, {
        status: 'success',
        finished_at: event.ts,
        duration_ms: event.duration_ms,
        output: event.output
      });
      execution.completed_steps = execution.steps.filter((item) => item.status === 'success').length;
      execution.percent = execution.total_steps === 0
        ? 100
        : Math.round((execution.completed_steps / execution.total_steps) * 100);
      logJob(job, 'info', `Шаг ${event.step_index + 1}/${execution.total_steps} завершён`, {
        action: event.action,
        step_id: event.step_id,
        duration_ms: event.duration_ms,
        output: event.output
      });
    } else if (event.type === 'step_failed') {
      Object.assign(step, {
        status: 'failed',
        finished_at: event.ts,
        duration_ms: event.duration_ms,
        error: event.error
      });
      execution.status = 'failed';
      logJob(job, 'error', `Ошибка шага ${event.step_index + 1}/${execution.total_steps}`, {
        action: event.action,
        step_id: event.step_id,
        duration_ms: event.duration_ms,
        error: event.error
      });
    }
    return;
  }

  if (event.type === 'inter_step_delay_started') {
    logJob(job, 'info', `Пауза между шагами: ${event.duration_ms} мс`, {
      after_step: event.after_step_index + 1,
      before_step: event.before_step_index + 1,
      duration_ms: event.duration_ms
    });
    return;
  }

  if (event.type === 'script_completed') {
    execution.status = 'success';
    execution.current_step = null;
    execution.completed_steps = execution.total_steps;
    execution.percent = 100;
    execution.finished_at = event.ts;
    execution.duration_ms = event.result.duration_ms;
    execution.context = event.result.context;
  }
}

async function executeJob(job) {
  const controller = new AbortController();
  state.controllers.set(job.job_id, controller);
  const timeoutTimer = setTimeout(() => {
    controller.abort(createApiError('TIMEOUT_ERROR', `Задание превысило тайм-аут ${job.timeout_ms} мс`, 408, true));
  }, job.timeout_ms);

  try {
    job.attempts += 1;
    job.status = 'running';
    job.error = null;
    job.started_at = job.started_at || nowIso();
    job.updated_at = nowIso();
    logJob(job, 'info', 'Выполнение задания начато', { attempt: job.attempts });

    const script = job.request.script || {};
    const steps = Array.isArray(script.steps) ? script.steps : [];
    const simulatedOutcome = script.simulate?.outcome || 'success';
    const simulatedDelay = Number.isFinite(script.simulate?.delay_ms) ? script.simulate.delay_ms : 250;
    const browserReplay = isPuppeteerReplayScript(script);
    logJob(job, 'debug', 'Сценарий подготовлен к выполнению', {
      runtime: browserReplay ? 'puppeteer-replay' : 'json-steps',
      steps_total: steps.length,
      request_hash: job.request_hash
    });
    const serviceBaseUrl = process.env.SERVICE_BASE_URL || `http://127.0.0.1:${PORT}`;
    const artifactDirectory = path.join(ARTIFACTS_DIR, job.job_id);
    const publicArtifactBasePath = `/artifacts/${encodeURIComponent(job.job_id)}`;
    const runtimeContext = {
      demo_mail_url: `${serviceBaseUrl}/demo/mail`,
      mail_login: DEMO_MAIL_LOGIN,
      mail_password: DEMO_MAIL_PASSWORD,
      yahoo_mail_url: YAHOO_MAIL_URL,
      yahoo_login: YAHOO_MAIL_LOGIN,
      yahoo_password: YAHOO_MAIL_PASSWORD,
      mail_to: YAHOO_MAIL_RECIPIENT,
      ...(job.request.context ?? {})
    };

    if (browserReplay
      && JSON.stringify(script).includes('{{yahoo_password}}')
      && !runtimeContext.yahoo_password) {
      throw createApiError(
        'MISSING_SECRET',
        'Для реальной отправки через Yahoo задайте YAHOO_MAIL_PASSWORD в .env',
        400,
        false
      );
    }

    const interpreterResult = browserReplay
      ? await executeBrowserReplay({
        script,
        context: runtimeContext,
        signal: controller.signal,
        timeoutMs: Math.min(job.timeout_ms, 30_000),
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: process.env.BROWSER_HEADLESS !== 'false',
        stepDelayMs: process.env.BROWSER_STEP_DELAY_MS,
        holdOpenMs: process.env.BROWSER_HOLD_OPEN_MS,
        captchaWaitMs: process.env.BROWSER_CAPTCHA_WAIT_MS,
        windowWidth: process.env.BROWSER_WINDOW_WIDTH,
        windowHeight: process.env.BROWSER_WINDOW_HEIGHT,
        artifactDirectory,
        publicArtifactBasePath,
        jobId: job.job_id,
        onEvent: (event) => applyInterpreterEvent(job, event),
        onBrowserLog: (level, message) => logJob(job, level, message)
      })
      : await executeScript({
        script: { ...script, steps },
        signal: controller.signal,
        registry: createDefaultStepRegistry({
          allowedRoots: STEP_ALLOWED_ROOTS,
          artifactDirectory,
          publicArtifactBasePath,
          downloadBaseUrl: serviceBaseUrl,
          openFile: ({ file, signal }) => openFileInBrowser({
            filePath: file,
            signal,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            headless: process.env.BROWSER_HEADLESS !== 'false',
            holdOpenMs: process.env.BROWSER_HOLD_OPEN_MS,
            windowWidth: process.env.BROWSER_WINDOW_WIDTH,
            windowHeight: process.env.BROWSER_WINDOW_HEIGHT,
            artifactDirectory,
            publicArtifactBasePath,
            jobId: job.job_id,
            onBrowserLog: (level, message) => logJob(job, level, message)
          })
        }),
        defaultStepTimeoutMs: Math.min(job.timeout_ms, 10_000),
        initialContext: {
          service_base_url: serviceBaseUrl,
          demo_file_url: `${serviceBaseUrl}/demo/files/stage4-download-demo.html`,
          ...(job.request.context ?? {})
        },
        attempt: job.attempts,
        onEvent: (event) => applyInterpreterEvent(job, event)
      });

    if (!browserReplay) {
      if (steps.length === 0 && simulatedDelay > 0) await abortableDelay(simulatedDelay, controller.signal);

      if (simulatedOutcome === 'validation_failed') {
        throw createApiError('VALIDATION_ERROR', 'Имитация ошибки проверки', 422, false);
      }

      if (simulatedOutcome === 'timeout') {
        await abortableDelay(job.timeout_ms + 50, controller.signal);
      }

      if (simulatedOutcome === 'retry_once' && job.attempts === 1) {
        throw createApiError('PLUGIN_NOT_RUNNING', 'Временная ошибка СБИС Плагина', 503, true);
      }
    }

    job.status = 'success';
    job.result = {
      message: 'Задание успешно выполнено',
      ...interpreterResult,
      job_id: job.job_id,
      uid: job.uid,
      un_id: UN_ID,
      artifacts: Array.isArray(interpreterResult.context?.artifacts)
        ? exposeArtifacts(job.job_id, interpreterResult.context.artifacts)
        : [],
      runtime: browserReplay ? 'puppeteer-replay' : 'json-steps',
      ...(!browserReplay ? { simulated_outcome: simulatedOutcome } : {})
    };
    job.finished_at = nowIso();
    logJob(job, 'info', 'Задание успешно выполнено', job.result);
  } catch (error) {
    if (error?.code === 'CANCELLED') {
      job.status = 'cancelled';
      job.error = serializeJobError(error);
      job.execution.status = 'cancelled';
      job.execution.finished_at = nowIso();
      job.finished_at = nowIso();
      logJob(job, 'warn', 'Задание отменено', job.error);
      return;
    }

    if (error?.code === 'TIMEOUT_ERROR') {
      job.status = 'timeout';
      job.error = serializeJobError(error);
      job.execution.status = 'timeout';
      job.execution.finished_at = nowIso();
      job.finished_at = nowIso();
      logJob(job, 'error', 'Превышен тайм-аут задания', job.error);
      return;
    }

    if (job.attempts < job.max_attempts && isRetryableError(error)) {
      job.status = 'retrying';
      job.error = serializeJobError(error);
      job.execution.status = 'retrying';
      logJob(job, 'warn', 'Ошибка выполнения, запланирована повторная попытка', job.error);
      try {
        await abortableDelay(job.request.retry_policy?.backoff_ms ?? state.config.retry_policy.backoff_ms, controller.signal);
      } catch (backoffError) {
        job.status = backoffError?.code === 'TIMEOUT_ERROR' ? 'timeout' : 'cancelled';
        job.execution.status = job.status;
        job.error = {
          code: backoffError?.code || 'CANCELLED',
          message: backoffError?.message || 'Задание отменено во время ожидания повторной попытки'
        };
        job.finished_at = nowIso();
        job.execution.finished_at = job.finished_at;
        logJob(job, job.status === 'timeout' ? 'error' : 'warn', 'Повторная попытка задания отменена', job.error);
        return;
      }
      job.status = 'queued';
      enqueue(job);
      schedulePersist();
      drainQueue();
      return;
    }

    job.status = error?.code === 'VALIDATION_ERROR' || error?.code === 'INVALID_SCRIPT'
      ? 'validation_failed'
      : 'failed';
    job.error = serializeJobError(error);
    const diagnosticArtifact = error?.details?.artifact;
    const partialContext = error?.partial_context;
    const partialArtifacts = Array.isArray(partialContext?.artifacts) ? partialContext.artifacts : [];
    if (diagnosticArtifact || partialContext) {
      job.result = {
        message: diagnosticArtifact
          ? 'Сценарий завершился с ошибкой; сохранён диагностический скриншот'
          : 'Сценарий завершился с ошибкой; сохранён частичный результат',
        job_id: job.job_id,
        uid: job.uid,
        un_id: UN_ID,
        ...(partialContext ? { context: partialContext } : {}),
        artifacts: exposeArtifacts(
          job.job_id,
          diagnosticArtifact ? [...partialArtifacts, diagnosticArtifact] : partialArtifacts
        ),
        runtime: isPuppeteerReplayScript(job.request.script) ? 'puppeteer-replay' : 'json-steps'
      };
    }
    if (partialContext) job.execution.context = partialContext;
    job.execution.status = job.status;
    job.execution.finished_at = nowIso();
    job.finished_at = nowIso();
    logJob(job, 'error', 'Задание завершилось с ошибкой', job.error);
  } finally {
    clearTimeout(timeoutTimer);
    state.controllers.delete(job.job_id);
  }
}

function drainQueue() {
  while (state.activeCount < state.config.max_parallel_jobs && state.queue.length > 0) {
    const jobId = state.queue.shift();
    const job = state.jobs.get(jobId);
    if (!job) continue;
    if (job.status !== 'queued') continue;

    state.activeCount += 1;
    state.running.add(jobId);
    executeJob(job)
      .catch((error) => {
        job.status = 'failed';
        job.error = {
          code: error?.code || 'INTERNAL_ERROR',
          message: error?.message || 'Непредвиденная ошибка выполнения'
        };
        job.finished_at = nowIso();
        logJob(job, 'error', 'Аварийное завершение задания', job.error);
      })
      .finally(() => {
        state.activeCount -= 1;
        state.running.delete(jobId);
        scheduleResultCallback(job);
        drainQueue();
      });
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_SIZE) {
        reject(createApiError('PAYLOAD_TOO_LARGE', 'Тело запроса слишком большое', 413, false));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(createApiError('INVALID_JSON', 'Некорректный JSON в теле запроса', 400, false));
      }
    });
    req.on('error', reject);
  });
}

function requireApiKey(req) {
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) {
    throw createApiError('UNAUTHORIZED', 'Отсутствует или неверно указан X-API-Key', 401, false);
  }
}

function isVersionedPath(pathname) {
  return pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);
}

function stripBasePath(pathname) {
  if (!isVersionedPath(pathname)) return pathname;
  return pathname.slice(BASE_PATH.length) || '/';
}

function buildQueueHealth() {
  const maxParallelJobs = state.config.max_parallel_jobs;
  const running = state.running.size;
  const queued = state.queue.length;
  return {
    status: running >= maxParallelJobs ? 'busy' : queued > 0 || running > 0 ? 'processing' : 'idle',
    queued,
    running,
    max_parallel_jobs: maxParallelJobs,
    available_slots: Math.max(0, maxParallelJobs - running)
  };
}

async function buildReadinessChecks() {
  const checks = {
    database: { status: 'ok' },
    filesystem: { status: 'ok', path: DATA_DIR },
    browser: { status: 'ok', executable_path: null }
  };

  try {
    if (!db) throw new Error('SQLite не инициализирована');
    db.prepare('SELECT 1 AS ready').get();
  } catch (error) {
    checks.database = { status: 'error', message: error.message };
  }

  try {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await access(DATA_DIR, fsConstants.R_OK | fsConstants.W_OK);
    await access(ARTIFACTS_DIR, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    checks.filesystem = { status: 'error', path: DATA_DIR, message: error.message };
  }

  const browserExecutable = await resolveBrowserExecutablePath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (browserExecutable) {
    checks.browser.executable_path = browserExecutable;
  } else {
    checks.browser = {
      status: 'error',
      executable_path: null,
      message: 'Не найден исполняемый файл Chromium или Яндекс Браузера'
    };
  }

  return checks;
}

async function buildHealthResponse(requestId) {
  const headless = process.env.BROWSER_HEADLESS !== 'false';
  const noVncConfigured = process.env.NOVNC_ENABLED === 'true';
  const checks = await buildReadinessChecks();
  const failedCheck = Object.entries(checks).find(([, check]) => check.status !== 'ok');
  const ready = !failedCheck;
  return {
    status: ready ? 'ok' : 'error',
    ready,
    service: 'script-factory',
    request_id: requestId,
    un_id: UN_ID,
    checks,
    ...(!ready ? {
      error: {
        code: `${failedCheck[0].toUpperCase()}_UNAVAILABLE`,
        message: failedCheck[1].message || `Проверка ${failedCheck[0]} завершилась ошибкой`
      }
    } : {}),
    queue: buildQueueHealth(),
    browser_replay: {
      available: checks.browser.status === 'ok',
      engine: '@puppeteer/replay',
      browser_product: process.env.BROWSER_PRODUCT || 'chromium-compatible',
      executable_path: checks.browser.executable_path,
      headless,
      step_delay_ms: Number(process.env.BROWSER_STEP_DELAY_MS || 0),
      captcha_wait_ms: Number(process.env.BROWSER_CAPTCHA_WAIT_MS || 0),
      live_view: {
        enabled: noVncConfigured && !headless,
        port: Number(process.env.NOVNC_PUBLIC_PORT || 33303),
        public_url: process.env.NOVNC_PUBLIC_URL || null,
        path: '/vnc.html?autoconnect=1&resize=scale&path=websockify',
        embedded_url: `${NOVNC_PROXY_PREFIX}/vnc.html?autoconnect=1&resize=scale&path=websockify`
      }
    }
  };
}

function buildSystemResources() {
  const headless = process.env.BROWSER_HEADLESS !== 'false';
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const cpuUsage = process.cpuUsage();
  const cpuTime = process.hrtime.bigint();
  const elapsedMicros = Math.max(1, Number(cpuTime - previousCpuSample.time) / 1000);
  const processCpuPercent = ((cpuUsage.user - previousCpuSample.usage.user)
    + (cpuUsage.system - previousCpuSample.usage.system)) / elapsedMicros * 100;
  previousCpuSample = { usage: cpuUsage, time: cpuTime };
  const cpuList = os.cpus();
  let deltaIdle = 0;
  let deltaTotal = 0;
  cpuList.forEach((cpu, index) => {
    const previous = previousSystemCpuSample[index] ?? cpu.times;
    const currentTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
    deltaIdle += cpu.times.idle - previous.idle;
    deltaTotal += currentTotal - previousTotal;
  });
  previousSystemCpuSample = cpuList.map((cpu) => ({ ...cpu.times }));
  const systemCpuPercent = deltaTotal > 0 ? (1 - deltaIdle / deltaTotal) * 100 : 0;
  let disk = null;
  try {
    const diskStat = statfsSync(DATA_DIR);
    const totalBytes = diskStat.blocks * diskStat.bsize;
    const freeBytes = diskStat.bavail * diskStat.bsize;
    disk = {
      path: DATA_DIR,
      total_bytes: totalBytes,
      free_bytes: freeBytes,
      used_percent: totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10 : 0
    };
  } catch {
    // Resource reporting must not make the health endpoint unavailable.
  }
  return {
    un_id: UN_ID,
    uptime_seconds: Math.floor((Date.now() - state.startedAt) / 1000),
    cpu: {
      logical_cores: cpuList.length,
      system_percent: Math.round(systemCpuPercent * 10) / 10,
      process_percent: Math.round(processCpuPercent * 10) / 10,
      load_average: os.loadavg()
    },
    memory: {
      total_bytes: totalMemory,
      free_bytes: freeMemory,
      used_percent: totalMemory > 0 ? Math.round((1 - freeMemory / totalMemory) * 1000) / 10 : 0,
      process_rss_bytes: memoryUsage.rss,
      process_heap_used_bytes: memoryUsage.heapUsed
    },
    disk,
    memory_usage: memoryUsage,
    jobs_total: state.jobs.size,
    jobs_running: state.running.size,
    jobs_queued: state.queue.length,
    queue: buildQueueHealth(),
    browser_replay: {
      available: true,
      browser_product: process.env.BROWSER_PRODUCT || 'chromium-compatible',
      executable_path: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      headless,
      step_delay_ms: Number(process.env.BROWSER_STEP_DELAY_MS || 0),
      captcha_wait_ms: Number(process.env.BROWSER_CAPTCHA_WAIT_MS || 0),
      live_view_enabled: process.env.NOVNC_ENABLED === 'true' && !headless,
      demo_mail_messages: demoMail.messageCount
    },
    node_version: process.version
  };
}

function validateConfigPatch(payload) {
  const next = { ...state.config };

  if (payload.max_parallel_jobs !== undefined) {
    if (!Number.isInteger(payload.max_parallel_jobs) || payload.max_parallel_jobs < 1) {
      throw createApiError('INVALID_CONFIG', 'max_parallel_jobs должен быть положительным целым числом', 400, false);
    }
    next.max_parallel_jobs = payload.max_parallel_jobs;
  }

  if (payload.default_job_timeout_ms !== undefined) {
    if (!Number.isInteger(payload.default_job_timeout_ms) || payload.default_job_timeout_ms < 1) {
      throw createApiError('INVALID_CONFIG', 'default_job_timeout_ms должен быть положительным целым числом', 400, false);
    }
    next.default_job_timeout_ms = payload.default_job_timeout_ms;
  }

  if (payload.retry_policy !== undefined) {
    const retry = payload.retry_policy;
    if (typeof retry !== 'object' || retry === null) {
      throw createApiError('INVALID_CONFIG', 'retry_policy должен быть объектом', 400, false);
    }
    if (retry.max_attempts !== undefined) {
      if (!Number.isInteger(retry.max_attempts) || retry.max_attempts < 1) {
        throw createApiError('INVALID_CONFIG', 'retry_policy.max_attempts должен быть положительным целым числом', 400, false);
      }
      next.retry_policy.max_attempts = retry.max_attempts;
    }
    if (retry.backoff_ms !== undefined) {
      if (!Number.isInteger(retry.backoff_ms) || retry.backoff_ms < 0) {
        throw createApiError('INVALID_CONFIG', 'retry_policy.backoff_ms должен быть неотрицательным целым числом', 400, false);
      }
      next.retry_policy.backoff_ms = retry.backoff_ms;
    }
  }

  return next;
}

function validateJobPayload(payload) {
  const errors = [];
  if (payload.uid !== undefined && (typeof payload.uid !== 'string' || !payload.uid.trim())) {
    errors.push({ path: 'uid', message: 'uid должен быть непустой строкой' });
  }
  if (payload.log_level !== undefined && !LOG_LEVEL_PRIORITY.has(payload.log_level)) {
    errors.push({ path: 'log_level', message: `log_level должен быть одним из: ${LOG_LEVELS.join(', ')}` });
  }
  if (payload.priority !== undefined && !Number.isFinite(payload.priority)) {
    errors.push({ path: 'priority', message: 'priority должен быть конечным числом' });
  }
  if (payload.timeout_ms !== undefined && (!Number.isInteger(payload.timeout_ms) || payload.timeout_ms < 1)) {
    errors.push({ path: 'timeout_ms', message: 'timeout_ms должен быть положительным целым числом' });
  }
  if (payload.context !== undefined && (!payload.context || typeof payload.context !== 'object' || Array.isArray(payload.context))) {
    errors.push({ path: 'context', message: 'context должен быть объектом' });
  }
  if (payload.retry_policy !== undefined) {
    if (!payload.retry_policy || typeof payload.retry_policy !== 'object' || Array.isArray(payload.retry_policy)) {
      errors.push({ path: 'retry_policy', message: 'retry_policy должен быть объектом' });
    } else {
      if (payload.retry_policy.max_attempts !== undefined
        && (!Number.isInteger(payload.retry_policy.max_attempts) || payload.retry_policy.max_attempts < 1)) {
        errors.push({ path: 'retry_policy.max_attempts', message: 'max_attempts должен быть положительным целым числом' });
      }
      if (payload.retry_policy.backoff_ms !== undefined
        && (!Number.isInteger(payload.retry_policy.backoff_ms) || payload.retry_policy.backoff_ms < 0)) {
        errors.push({ path: 'retry_policy.backoff_ms', message: 'backoff_ms должен быть неотрицательным целым числом' });
      }
    }
  }
  if (payload.callback !== undefined) {
    const callback = payload.callback;
    if (!callback || typeof callback !== 'object' || Array.isArray(callback)) {
      errors.push({ path: 'callback', message: 'callback должен быть объектом' });
    } else {
      if (typeof callback.url !== 'string' || !callback.url.trim()) {
        errors.push({ path: 'callback.url', message: 'callback.url должен быть непустой строкой' });
      } else {
        try {
          validateCallbackOrigin(callback.url);
        } catch (error) {
          errors.push({ path: 'callback.url', message: error.message });
        }
      }
      if (callback.max_attempts !== undefined
        && (!Number.isInteger(callback.max_attempts) || callback.max_attempts < 1 || callback.max_attempts > 20)) {
        errors.push({ path: 'callback.max_attempts', message: 'max_attempts должен быть целым числом от 1 до 20' });
      }
      if (callback.backoff_ms !== undefined
        && (!Number.isInteger(callback.backoff_ms) || callback.backoff_ms < 0 || callback.backoff_ms > 60_000)) {
        errors.push({ path: 'callback.backoff_ms', message: 'backoff_ms должен быть целым числом от 0 до 60000' });
      }
      if (callback.timeout_ms !== undefined
        && (!Number.isInteger(callback.timeout_ms) || callback.timeout_ms < 1 || callback.timeout_ms > 60_000)) {
        errors.push({ path: 'callback.timeout_ms', message: 'timeout_ms должен быть целым числом от 1 до 60000' });
      }
    }
  }
  return errors;
}

const server = http.createServer(async (req, res) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    if (pathname === '/health') {
      const health = await buildHealthResponse(requestId);
      sendJson(res, health.ready ? 200 : 503, health);
      return;
    }

    if (method === 'POST' && pathname === '/demo/1c/callback' && DEMO_1C_CALLBACK_ENABLED) {
      if (CALLBACK_AUTH_TOKEN && req.headers.authorization !== `Bearer ${CALLBACK_AUTH_TOKEN}`) {
        sendJson(res, 401, { error: { code: 'INVALID_CALLBACK_TOKEN', message: 'Неверный callback-токен' } });
        return;
      }
      const event = await readJsonBody(req);
      const failOnceKey = requestUrl.searchParams.get('fail_once');
      if (failOnceKey && !state.demoCallbackFailures.has(failOnceKey)) {
        state.demoCallbackFailures.add(failOnceKey);
        sendJson(res, 503, { error: { code: 'DEMO_CALLBACK_FAILURE', message: 'Первая попытка отклонена для демонстрации retry' } });
        return;
      }
      if (!state.demoCallbackEvents.some((item) => item.event_id === event.event_id)) {
        state.demoCallbackEvents.push(event);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.startsWith('/demo/mail/api/') && await demoMail.handle(req, res, requestUrl)) return;

    if (method === 'GET' && (pathname === '/demo/mail' || pathname === '/demo/mail/')) {
      await sendPublicFile(res, 'demo-mail.html');
      return;
    }

    if (method === 'GET' && (pathname === '/demo-mail.js' || pathname === '/demo-mail.css')) {
      await sendPublicFile(res, pathname.slice(1));
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      if (isWebAuthenticated(req)) {
        redirect(res, '/');
        return;
      }
      await sendPublicFile(res, 'login.html');
      return;
    }

    if (method === 'POST' && pathname === '/auth/login') {
      const payload = await readJsonBody(req);
      const loginMatches = secureTextEqual(payload?.login, WEB_LOGIN);
      const passwordMatches = secureTextEqual(payload?.password, WEB_PASSWORD);
      if (!loginMatches || !passwordMatches) {
        sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Неверный логин или пароль' } });
        return;
      }
      const token = createWebSession();
      res.setHeader('Set-Cookie', sessionCookie(token));
      sendJson(res, 200, { authenticated: true });
      return;
    }

    if (method === 'POST' && pathname === '/auth/logout') {
      const token = sessionToken(req);
      if (token) webSessions.delete(token);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      redirect(res, '/login');
      return;
    }

    if (method === 'GET' && (pathname === NOVNC_PROXY_PREFIX || pathname.startsWith(`${NOVNC_PROXY_PREFIX}/`))) {
      if (process.env.NOVNC_ENABLED !== 'true') {
        sendJson(res, 404, { error: { code: 'NOVNC_DISABLED', message: 'Живой экран Chromium отключён' } });
        return;
      }
      if (!requireWebAuth(req, res, requestUrl)) return;
      proxyNoVncHttp(req, res, requestUrl);
      return;
    }

    const protectedWebPath = pathname === '/'
      || pathname === '/index.html'
      || pathname === '/queue'
      || pathname === '/docs'
      || pathname === '/openapi.yaml'
      || pathname === '/swagger-ru.js';
    if (method === 'GET' && protectedWebPath && !requireWebAuth(req, res, requestUrl)) return;

    if (method === 'GET' && pathname.startsWith('/artifacts/')) {
      if (!requireWebAuth(req, res, requestUrl)) return;
      await sendArtifactFile(res, pathname);
      return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await sendPublicFile(res, 'index.html');
      return;
    }

    if (method === 'GET' && pathname === '/queue') {
      await sendPublicFile(res, 'queue.html');
      return;
    }

    if (method === 'GET' && pathname.startsWith('/demo/files/')) {
      await sendDemoDownloadFile(res, pathname.slice('/demo/files/'.length));
      return;
    }

    if (method === 'GET' && (pathname === '/app.js' || pathname === '/scenarios.js' || pathname === '/styles.css')) {
      await sendPublicFile(res, pathname.slice(1));
      return;
    }

    if (pathname === '/openapi.yaml') {
      await sendOpenApiYaml(res);
      return;
    }

    if (pathname === '/swagger-ru.js') {
      await sendSwaggerLocalization(res);
      return;
    }

    if (pathname === '/docs') {
      sendSwaggerUi(res);
      return;
    }

    if (!isVersionedPath(pathname)) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } });
      return;
    }

    applyCorsHeaders(res);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const resourcePath = stripBasePath(pathname);

    if (method === 'GET' && resourcePath === '/health') {
      const health = await buildHealthResponse(requestId);
      sendJson(res, health.ready ? 200 : 503, health);
      return;
    }

    requireApiKey(req);

    if (method === 'GET' && resourcePath === '/interpreter/actions') {
      sendJson(res, 200, { actions: stepRegistry.actions() });
      return;
    }

    if (method === 'GET' && resourcePath === '/demo/callback-events' && DEMO_1C_CALLBACK_ENABLED) {
      sendJson(res, 200, { items: state.demoCallbackEvents });
      return;
    }

    if (method === 'GET' && resourcePath === '/jobs') {
      const status = requestUrl.searchParams.get('status');
      const limit = Math.max(1, Number(requestUrl.searchParams.get('limit') || 100));
      const filtered = [...state.jobs.values()]
        .filter((job) => (status ? job.status === status : true))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const jobs = filtered
        .slice(0, limit)
        .map(summarizeJob);
      sendJson(res, 200, { items: jobs, total: filtered.length });
      return;
    }

    if (method === 'POST' && resourcePath === '/jobs') {
      const rawPayload = await readJsonBody(req);
      if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        throw createApiError('INVALID_PAYLOAD', 'Тело запроса должно быть JSON-объектом', 400, false);
      }
      const payload = normalizeJobCreatePayload(rawPayload);
      const idempotencyKeyHeader = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] : idempotencyKeyHeader;
      const queryUid = requestUrl.searchParams.get('uid');
      const suppliedIdentifiers = [queryUid, payload.uid, idempotencyKey]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());
      if (new Set(suppliedIdentifiers).size > 1) {
        throw createApiError(
          'IDEMPOTENCY_KEY_MISMATCH',
          'uid, параметр запроса uid и Idempotency-Key должны совпадать, если переданы одновременно',
          400,
          false
        );
      }
      const uid = suppliedIdentifiers[0] ?? `job_${randomUUID()}`;
      if (payload.script !== undefined && (typeof payload.script !== 'object' || payload.script === null)) {
        throw createApiError('INVALID_PAYLOAD', 'Поле script должно быть объектом', 400, false);
      }
      const payloadErrors = validateJobPayload(payload);
      if (payloadErrors.length > 0) {
        throw createApiError('INVALID_PAYLOAD', 'Задание не прошло проверку', 400, false, { errors: payloadErrors });
      }
      const script = payload.script ?? { steps: [] };
      const scriptErrors = validateScript(script, stepRegistry);
      if (scriptErrors.length > 0) {
        throw createApiError('INVALID_SCRIPT', 'Сценарий не прошёл проверку', 400, false, {
          errors: scriptErrors
        });
      }

      const normalizedRequest = { ...payload, script, uid };
      const incomingRequestHash = requestHash(normalizedRequest);
      const existing = suppliedIdentifiers.length > 0
        ? [...state.jobs.values()].find((job) => job.uid === uid)
        : null;
      if (existing) {
        const existingRequestHash = existing.request_hash ?? requestHash(existing.request);
        if (existingRequestHash !== incomingRequestHash) {
          throw createApiError(
            'IDEMPOTENCY_CONFLICT',
            'Задание с таким uid уже существует, но его параметры или сценарий отличаются',
            409,
            false,
            { job_id: existing.job_id, uid }
          );
        }
        sendJson(res, 200, { job: summarizeJob(existing), idempotent: true });
        return;
      }

      const job = createJobRecord(normalizedRequest, incomingRequestHash);
      state.jobs.set(job.job_id, job);
      enqueue(job);
      drainQueue();
      schedulePersist();
      sendJson(res, 201, { job: summarizeJob(job), idempotent: false });
      return;
    }

    if (method === 'GET' && resourcePath.startsWith('/jobs/')) {
      const parts = resourcePath.split('/').filter(Boolean);
      if (parts[1] === 'by-uid' && parts[2]) {
        const uid = decodeURIComponent(parts.slice(2).join('/'));
        const job = [...state.jobs.values()].find((item) => item.uid === uid);
        if (!job) {
          sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Задание с указанным uid не найдено' } });
          return;
        }
        sendJson(res, 200, { job: summarizeJob(job) });
        return;
      }
      const jobId = parts[1];
      const action = parts[2];
      const job = state.jobs.get(jobId);

      if (!job) {
        sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Задание не найдено' } });
        return;
      }

      if (!action) {
        sendJson(res, 200, { job: summarizeJob(job) });
        return;
      }

      if (action === 'artifacts' && parts[3]) {
        const identifier = decodeURIComponent(parts.slice(3).join('/'));
        const artifact = job.result?.artifacts?.find((item) => (
          item.artifact_id === identifier || item.filename === identifier
        ));
        await sendJobArtifactFile(res, job, artifact);
        return;
      }

      if (action === 'logs') {
        const minimumLevel = requestUrl.searchParams.get('min_level');
        if (minimumLevel && !LOG_LEVEL_PRIORITY.has(minimumLevel)) {
          throw createApiError('INVALID_LOG_LEVEL', `min_level должен быть одним из: ${LOG_LEVELS.join(', ')}`, 400, false);
        }
        const logs = minimumLevel
          ? job.logs.filter((entry) => (LOG_LEVEL_PRIORITY.get(entry.level) ?? 1) >= LOG_LEVEL_PRIORITY.get(minimumLevel))
          : job.logs;
        sendJson(res, 200, { job_id: job.job_id, log_level: job.log_level, logs });
        return;
      }
    }

    if (method === 'POST' && resourcePath.endsWith('/cancel')) {
      const parts = resourcePath.split('/').filter(Boolean);
      const jobId = parts[1];
      const job = state.jobs.get(jobId);

      if (!job) {
        sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Задание не найдено' } });
        return;
      }

      if (job.status === 'queued') {
        removeFromQueue(job.job_id);
        job.status = 'cancelled';
        job.finished_at = nowIso();
        job.error = { code: 'CANCELLED', message: 'Задание отменено до начала выполнения' };
        job.execution.status = 'cancelled';
        job.execution.finished_at = job.finished_at;
        logJob(job, 'warn', 'Задание отменено до начала выполнения', job.error);
        schedulePersist();
        scheduleResultCallback(job);
        sendJson(res, 200, { job: summarizeJob(job), cancelled: true });
        return;
      }

      if (job.status === 'running' || job.status === 'retrying') {
        job.cancellation_requested = true;
        state.controllers.get(job.job_id)?.abort(createApiError('CANCELLED', 'Задание отменено пользователем', 499, false));
        logJob(job, 'warn', 'Пользователь запросил отмену задания');
        schedulePersist();
        sendJson(res, 202, { job: summarizeJob(job), cancelled: false, message: 'Запрошена отмена задания' });
        return;
      }

      sendJson(res, 200, { job: summarizeJob(job), cancelled: false, message: 'Задание уже завершено' });
      return;
    }

    if (method === 'GET' && resourcePath === '/system/resources') {
      sendJson(res, 200, buildSystemResources());
      return;
    }

    if (method === 'GET' && resourcePath === '/system/config') {
      sendJson(res, 200, { config: state.config });
      return;
    }

    if (method === 'PUT' && resourcePath === '/system/config') {
      const payload = await readJsonBody(req);
      if (!payload || typeof payload !== 'object') {
        throw createApiError('INVALID_PAYLOAD', 'Тело запроса должно быть JSON-объектом', 400, false);
      }
      state.config = validateConfigPatch(payload);
      drainQueue();
      schedulePersist();
      sendJson(res, 200, { config: state.config });
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(res, statusCode, {
      error: {
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Непредвиденная ошибка',
        ...(error?.details === undefined ? {} : { details: error.details })
      }
    });
  }
});

server.on('upgrade', (req, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  if (requestUrl.pathname !== `${NOVNC_PROXY_PREFIX}/websockify`) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  if (process.env.NOVNC_ENABLED !== 'true' || !isWebAuthenticated(req)) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  const proxyRequest = http.request({
    hostname: '127.0.0.1',
    port: NOVNC_INTERNAL_PORT,
    method: 'GET',
    path: '/websockify',
    headers: { ...req.headers, host: `127.0.0.1:${NOVNC_INTERNAL_PORT}` }
  });
  proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
    writeUpgradeResponse(socket, proxyResponse);
    if (head.length > 0) proxySocket.write(head);
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    proxySocket.pipe(socket).pipe(proxySocket);
  });
  proxyRequest.on('response', () => rejectUpgrade(socket, 502, 'Bad Gateway'));
  proxyRequest.on('error', () => rejectUpgrade(socket, 502, 'Bad Gateway'));
  proxyRequest.end();
});

async function main() {
  validateRuntimeConfig();
  state.config = defaultConfig();
  await loadPersistedState();
  schedulePersist();
  await flushPersistence();
  for (const job of state.jobs.values()) scheduleResultCallback(job);
  drainQueue();

  server.listen(PORT, HOST, () => {
    console.log(`script-factory listening on http://${HOST}:${PORT}`);
  });
}

async function shutdown(code = 0) {
  await flushPersistence();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  for (const timer of state.callbackTimers.values()) clearTimeout(timer);
  state.callbackTimers.clear();
  if (db) {
    db.close();
    db = null;
  }
  server.close(() => process.exit(code));
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
