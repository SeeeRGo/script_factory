import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || 'dev-secret';
const BASE_PATH = '/api/v2';
const MAX_BODY_SIZE = 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.sqlite');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const OPENAPI_FILE = path.join(process.cwd(), 'openapi.yaml');
const PERSIST_DEBOUNCE_MS = Number(process.env.PERSIST_DEBOUNCE_MS || 50);
const CORS_ALLOWED_HEADERS = 'X-API-Key, Idempotency-Key, Content-Type, Accept, Origin, Authorization';
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';

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
  activeCount: 0
};

let persistTimer = null;
let persistRequested = false;
let db = null;

function nowIso() {
  return new Date().toISOString();
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
    cancellation_requested: job.cancellation_requested,
    logs: job.logs
  };
}

function restoreJob(snapshot) {
  const job = {
    job_id: snapshot.job_id,
    uid: snapshot.uid,
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
    cancellation_requested: Boolean(snapshot.cancellation_requested),
    logs: Array.isArray(snapshot.logs) ? snapshot.logs : []
  };

  if (job.status === 'running' || job.status === 'retrying') {
    job.status = 'queued';
    job.error = null;
    job.cancellation_requested = false;
    job.finished_at = null;
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
    throw createApiError('PERSISTENCE_LOAD_FAILED', `Failed to load legacy state: ${error.message}`, 500, false);
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
  state.activeCount = 0;
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
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Script Factory API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
      body {
        margin: 0;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
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

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '600');
}

function logJob(job, level, message, details = undefined) {
  job.logs.push({
    ts: nowIso(),
    level,
    message,
    ...(details === undefined ? {} : { details })
  });
  job.updated_at = nowIso();
  schedulePersist();
}

function createJobRecord(payload) {
  const job = {
    job_id: `job_${randomUUID()}`,
    uid: payload.uid,
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
    cancellation_requested: false,
    logs: []
  };

  logJob(job, 'info', 'Job created', { uid: job.uid, priority: job.priority });
  return job;
}

function summarizeJob(job) {
  return {
    job_id: job.job_id,
    uid: job.uid,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    result: job.result
  };
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

function createApiError(code, message, statusCode = 400, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}

function isRetryableError(error) {
  return Boolean(error?.retryable);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || createApiError('CANCELLED', 'Operation cancelled', 499, false));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal.reason || createApiError('CANCELLED', 'Operation cancelled', 499, false));
    };

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function executeStep(step, signal) {
  const action = step?.action || step?.type || 'noop';
  const params = step?.params || {};
  const duration = Number.isFinite(step?.timeout_ms) ? step.timeout_ms : Number(step?.duration_ms || 100);

  switch (action) {
    case 'check_ip': {
      if (params.expected_ip && params.current_ip && params.expected_ip !== params.current_ip) {
        throw createApiError('IP_MISMATCH', `Expected IP ${params.expected_ip}, got ${params.current_ip}`, 400, false);
      }
      break;
    }
    case 'find_files': {
      if (!Array.isArray(params.files) || params.files.length === 0) {
        throw createApiError('FILE_NOT_FOUND', 'No matching files found', 404, false);
      }
      break;
    }
    case 'validate_report': {
      if (params.valid === false || params.passed === false) {
        throw createApiError('VALIDATION_ERROR', 'Report validation failed', 422, false);
      }
      break;
    }
    case 'auth_ecp': {
      if (params.plugin_running === false) {
        throw createApiError('PLUGIN_NOT_RUNNING', 'SBIIS plugin is not running', 503, true);
      }
      break;
    }
    case 'upload_files':
    case 'launch_browser':
    case 'navigate':
    case 'submit_if_valid':
    case 'move_files':
    case 'noop':
      break;
    default:
      if (step?.action) {
        throw createApiError('UNKNOWN_ACTION', `Unsupported action: ${action}`, 400, false);
      }
  }

  await delay(duration, signal);
}

async function executeJob(job) {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    controller.abort(createApiError('TIMEOUT_ERROR', `Job timed out after ${job.timeout_ms}ms`, 408, true));
  }, job.timeout_ms);

  try {
    job.attempts += 1;
    job.status = 'running';
    job.started_at = job.started_at || nowIso();
    job.updated_at = nowIso();
    logJob(job, 'info', 'Job started', { attempt: job.attempts });

    const script = job.request.script || {};
    const steps = Array.isArray(script.steps) ? script.steps : [];
    const simulatedOutcome = script.simulate?.outcome || 'success';
    const simulatedDelay = Number.isFinite(script.simulate?.delay_ms) ? script.simulate.delay_ms : 250;

    if (steps.length === 0) {
      await delay(simulatedDelay, controller.signal);
    }

    for (let index = 0; index < steps.length; index += 1) {
      if (job.cancellation_requested) {
        throw createApiError('CANCELLED', 'Job cancelled by user', 499, false);
      }

      const step = steps[index];
      logJob(job, 'info', `Step ${index + 1}/${steps.length} started`, {
        action: step?.action || step?.type || 'noop'
      });
      await executeStep(step, controller.signal);
      logJob(job, 'info', `Step ${index + 1}/${steps.length} completed`, {
        action: step?.action || step?.type || 'noop'
      });
    }

    if (simulatedOutcome === 'validation_failed') {
      throw createApiError('VALIDATION_ERROR', 'Simulated validation failure', 422, false);
    }

    if (simulatedOutcome === 'timeout') {
      await delay(job.timeout_ms + 50, controller.signal);
    }

    if (simulatedOutcome === 'retry_once' && job.attempts === 1) {
      throw createApiError('PLUGIN_NOT_RUNNING', 'Transient plugin issue', 503, true);
    }

    job.status = 'success';
    job.result = {
      message: 'Job completed successfully',
      steps_executed: steps.length,
      simulated_outcome: simulatedOutcome
    };
    job.finished_at = nowIso();
    logJob(job, 'info', 'Job completed successfully', job.result);
  } catch (error) {
    if (error?.code === 'CANCELLED') {
      job.status = 'cancelled';
      job.error = { code: error.code, message: error.message };
      job.finished_at = nowIso();
      logJob(job, 'warn', 'Job cancelled', job.error);
      return;
    }

    if (error?.code === 'TIMEOUT_ERROR') {
      job.status = 'timeout';
      job.error = { code: error.code, message: error.message };
      job.finished_at = nowIso();
      logJob(job, 'error', 'Job timed out', job.error);
      return;
    }

    if (job.attempts < job.max_attempts && isRetryableError(error)) {
      job.status = 'retrying';
      job.error = { code: error.code, message: error.message };
      logJob(job, 'warn', 'Job failed, scheduling retry', job.error);
      await delay(state.config.retry_policy.backoff_ms, controller.signal);
      job.status = 'queued';
      enqueue(job);
      schedulePersist();
      drainQueue();
      return;
    }

    job.status = error?.code === 'VALIDATION_ERROR' ? 'validation_failed' : 'failed';
    job.error = {
      code: error?.code || 'INTERNAL_ERROR',
      message: error?.message || 'Unexpected failure'
    };
    job.finished_at = nowIso();
    logJob(job, 'error', 'Job failed', job.error);
  } finally {
    clearTimeout(timeoutTimer);
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
          message: error?.message || 'Unexpected failure'
        };
        job.finished_at = nowIso();
        logJob(job, 'error', 'Job crashed', job.error);
      })
      .finally(() => {
        state.activeCount -= 1;
        state.running.delete(jobId);
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
        reject(createApiError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413, false));
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
        reject(createApiError('INVALID_JSON', 'Invalid JSON payload', 400, false));
      }
    });
    req.on('error', reject);
  });
}

function requireApiKey(req) {
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) {
    throw createApiError('UNAUTHORIZED', 'Missing or invalid X-API-Key', 401, false);
  }
}

function isVersionedPath(pathname) {
  return pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);
}

function stripBasePath(pathname) {
  if (!isVersionedPath(pathname)) return pathname;
  return pathname.slice(BASE_PATH.length) || '/';
}

function buildSystemResources() {
  return {
    uptime_seconds: Math.floor((Date.now() - state.startedAt) / 1000),
    memory_usage: process.memoryUsage(),
    jobs_total: state.jobs.size,
    jobs_running: state.running.size,
    jobs_queued: state.queue.length,
    node_version: process.version
  };
}

function validateConfigPatch(payload) {
  const next = { ...state.config };

  if (payload.max_parallel_jobs !== undefined) {
    if (!Number.isInteger(payload.max_parallel_jobs) || payload.max_parallel_jobs < 1) {
      throw createApiError('INVALID_CONFIG', 'max_parallel_jobs must be a positive integer', 400, false);
    }
    next.max_parallel_jobs = payload.max_parallel_jobs;
  }

  if (payload.default_job_timeout_ms !== undefined) {
    if (!Number.isInteger(payload.default_job_timeout_ms) || payload.default_job_timeout_ms < 1) {
      throw createApiError('INVALID_CONFIG', 'default_job_timeout_ms must be a positive integer', 400, false);
    }
    next.default_job_timeout_ms = payload.default_job_timeout_ms;
  }

  if (payload.retry_policy !== undefined) {
    const retry = payload.retry_policy;
    if (typeof retry !== 'object' || retry === null) {
      throw createApiError('INVALID_CONFIG', 'retry_policy must be an object', 400, false);
    }
    if (retry.max_attempts !== undefined) {
      if (!Number.isInteger(retry.max_attempts) || retry.max_attempts < 1) {
        throw createApiError('INVALID_CONFIG', 'retry_policy.max_attempts must be a positive integer', 400, false);
      }
      next.retry_policy.max_attempts = retry.max_attempts;
    }
    if (retry.backoff_ms !== undefined) {
      if (!Number.isInteger(retry.backoff_ms) || retry.backoff_ms < 0) {
        throw createApiError('INVALID_CONFIG', 'retry_policy.backoff_ms must be a non-negative integer', 400, false);
      }
      next.retry_policy.backoff_ms = retry.backoff_ms;
    }
  }

  return next;
}

const server = http.createServer(async (req, res) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    if (pathname === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'script-factory', request_id: requestId });
      return;
    }

    if (pathname === '/openapi.yaml') {
      await sendOpenApiYaml(res);
      return;
    }

    if (pathname === '/docs') {
      sendSwaggerUi(res);
      return;
    }

    if (!isVersionedPath(pathname)) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
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
      sendJson(res, 200, { status: 'ok', service: 'script-factory', request_id: requestId });
      return;
    }

    requireApiKey(req);

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
      const payload = await readJsonBody(req);
      if (!payload || typeof payload !== 'object') {
        throw createApiError('INVALID_PAYLOAD', 'Request body must be a JSON object', 400, false);
      }
      const idempotencyKeyHeader = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] : idempotencyKeyHeader;
      const explicitUid = requestUrl.searchParams.get('uid') || payload.uid;
      const uid = typeof explicitUid === 'string' && explicitUid.trim()
        ? explicitUid.trim()
        : typeof idempotencyKey === 'string' && idempotencyKey.trim()
          ? idempotencyKey.trim()
          : `job_${randomUUID()}`;
      if (payload.script !== undefined && (typeof payload.script !== 'object' || payload.script === null)) {
        throw createApiError('INVALID_PAYLOAD', 'script must be an object', 400, false);
      }

      const existing = (typeof explicitUid === 'string' && explicitUid.trim())
        ? [...state.jobs.values()].find((job) => job.uid === uid)
        : (typeof idempotencyKey === 'string' && idempotencyKey.trim())
          ? [...state.jobs.values()].find((job) => job.uid === uid)
          : null;
      if (existing) {
        sendJson(res, 200, { job: summarizeJob(existing), idempotent: true });
        return;
      }

      const job = createJobRecord({ ...payload, uid });
      state.jobs.set(job.job_id, job);
      enqueue(job);
      drainQueue();
      schedulePersist();
      sendJson(res, 201, { job: summarizeJob(job), idempotent: false });
      return;
    }

    if (method === 'GET' && resourcePath.startsWith('/jobs/')) {
      const parts = resourcePath.split('/').filter(Boolean);
      const jobId = parts[1];
      const action = parts[2];
      const job = state.jobs.get(jobId);

      if (!job) {
        sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
        return;
      }

      if (!action) {
        sendJson(res, 200, { job: summarizeJob(job) });
        return;
      }

      if (action === 'logs') {
        sendJson(res, 200, { job_id: job.job_id, logs: job.logs });
        return;
      }
    }

    if (method === 'POST' && resourcePath.endsWith('/cancel')) {
      const parts = resourcePath.split('/').filter(Boolean);
      const jobId = parts[1];
      const job = state.jobs.get(jobId);

      if (!job) {
        sendJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
        return;
      }

      if (job.status === 'queued') {
        removeFromQueue(job.job_id);
        job.status = 'cancelled';
        job.finished_at = nowIso();
        job.error = { code: 'CANCELLED', message: 'Job cancelled before execution' };
        logJob(job, 'warn', 'Job cancelled before execution', job.error);
        schedulePersist();
        sendJson(res, 200, { job: summarizeJob(job), cancelled: true });
        return;
      }

      if (job.status === 'running' || job.status === 'retrying') {
        job.cancellation_requested = true;
        logJob(job, 'warn', 'Cancellation requested by user');
        schedulePersist();
        sendJson(res, 202, { job: summarizeJob(job), cancelled: false, message: 'Cancellation requested' });
        return;
      }

      sendJson(res, 200, { job: summarizeJob(job), cancelled: false, message: 'Job is already finished' });
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
        throw createApiError('INVALID_PAYLOAD', 'Request body must be a JSON object', 400, false);
      }
      state.config = validateConfigPatch(payload);
      drainQueue();
      schedulePersist();
      sendJson(res, 200, { config: state.config });
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(res, statusCode, {
      error: {
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Unexpected error'
      }
    });
  }
});

async function main() {
  state.config = defaultConfig();
  await loadPersistedState();
  schedulePersist();
  await flushPersistence();

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
