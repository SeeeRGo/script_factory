import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runQueueCase } from '../demo/queue-case-lib.mjs';

const API_KEY = 'integration-secret';
const WEB_LOGIN = 'integration-user';
const WEB_PASSWORD = 'integration-password';
const UN_ID = 'un-integration-01';
const DEMO_MAIL_LOGIN = 'browser-demo-user';
const DEMO_MAIL_PASSWORD = 'browser-demo-password';
const PORT = 36000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${PORT}`;
const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
let child;
let dataDir;
let webCookie;
let webSetCookie;

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start in time');
}

async function request(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      'X-API-Key': API_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
}

async function webRequest(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      Cookie: webCookie,
      ...(options.headers || {})
    }
  });
}

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'script-factory-test-'));
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      API_KEY,
      UN_ID,
      WEB_LOGIN,
      WEB_PASSWORD,
      DEMO_MAIL_LOGIN,
      DEMO_MAIL_PASSWORD,
      YAHOO_MAIL_PASSWORD: '',
      CALLBACK_AUTH_TOKEN: 'callback-integration-token',
      DEMO_1C_CALLBACK_ENABLED: 'true',
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      BROWSER_HEADLESS: 'true',
      CALLBACK_ALLOWED_ORIGINS: origin,
      DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();

  const loginResponse = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: WEB_LOGIN, password: WEB_PASSWORD })
  });
  if (!loginResponse.ok) throw new Error('Test login failed');
  webSetCookie = loginResponse.headers.get('set-cookie');
  webCookie = webSetCookie.split(';')[0];
});

test.after(() => {
  child?.kill('SIGTERM');
});

test('redirects an unauthenticated browser to the login screen', async () => {
  const response = await fetch(`${origin}/queue?view=active`, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/login?next=%2Fqueue%3Fview%3Dactive');
});

test('serves a minimal login screen and rejects invalid credentials', async () => {
  const pageResponse = await fetch(`${origin}/login`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Вход в систему/);

  const loginResponse = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: WEB_LOGIN, password: 'wrong-password' })
  });
  assert.equal(loginResponse.status, 401);
  assert.equal((await loginResponse.json()).error.code, 'INVALID_CREDENTIALS');
});

test('creates an HttpOnly browser session after login', () => {
  assert.match(webSetCookie, /script_factory_session=/);
  assert.match(webSetCookie, /HttpOnly/);
  assert.match(webSetCookie, /SameSite=Lax/);
});

test('healthcheck exposes this UN and its local queue state', async () => {
  for (const pathname of ['/health', '/api/v2/health']) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.ready, true);
    assert.equal(body.version, packageMetadata.version);
    assert.equal(body.release_date, packageMetadata.releaseDate);
    assert.equal(body.un_id, UN_ID);
    assert.equal(body.checks.database.status, 'ok');
    assert.equal(body.checks.filesystem.status, 'ok');
    assert.equal(body.checks.browser.status, 'ok');
    assert.equal(body.queue.queued, 0);
    assert.equal(body.queue.running, 0);
    assert.equal(body.queue.max_parallel_jobs, 1);
    assert.equal(body.queue.available_slots, 1);
    assert.equal(body.queue.status, 'idle');
    assert.equal(body.browser_replay.available, true);
    assert.equal(body.browser_replay.engine, '@puppeteer/replay');
    assert.equal(body.browser_replay.live_view.enabled, false);
    assert.match(body.browser_replay.live_view.embedded_url, /^\/browser-live\/vnc\.html/);
  }

  const resourcesResponse = await request('/api/v2/system/resources');
  assert.equal(resourcesResponse.status, 200);
  const resources = await resourcesResponse.json();
  assert.equal(resources.un_id, UN_ID);
  assert.equal(resources.api_version, 'v2');
  assert.equal(resources.service_version, packageMetadata.version);
  assert.equal(resources.release_date, packageMetadata.releaseDate);
  assert.ok(resources.cpu.cpu_logical_cores >= 1);
  assert.ok(resources.cpu.cpu_system_percent >= 0);
  assert.ok(resources.memory.memory_total_bytes > 0);
  assert.ok(resources.memory.memory_used_percent >= 0);
  assert.ok(resources.disk === null || resources.disk.disk_total_bytes > 0);
  assert.ok(typeof resources.yandex_browser_version === 'string' || resources.yandex_browser_version === null);
  assert.deepEqual(resources.queue, {
    queue_status: 'idle',
    queue_queued: 0,
    queue_running: 0,
    queue_max_parallel_jobs: 1,
    queue_available_slots: 1
  });
  const nestedLeafNames = [];
  const collectLeaves = (value, prefix) => {
    if (value === null || typeof value !== 'object') {
      nestedLeafNames.push(prefix);
      return;
    }
    for (const [key, item] of Object.entries(value)) collectLeaves(item, `${prefix}.${key}`);
  };
  collectLeaves(resources, '');
  assert.deepEqual(nestedLeafNames.filter((name) => name.split('.').length > 2), [...new Set(nestedLeafNames.filter((name) => name.split('.').length > 2))]);
});

test('exposes and validates the configurable job retention period', async () => {
  const initialResponse = await request('/api/v2/system/config');
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).config.job_retention_days, 30);

  const updateResponse = await request('/api/v2/system/config', {
    method: 'PUT',
    body: JSON.stringify({ job_retention_days: 31 })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).config.job_retention_days, 31);

  const invalidResponse = await request('/api/v2/system/config', {
    method: 'PUT',
    body: JSON.stringify({ job_retention_days: 0 })
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, 'INVALID_CONFIG');

  await request('/api/v2/system/config', {
    method: 'PUT',
    body: JSON.stringify({ job_retention_days: 30 })
  });
});

test('accepts separated parameters and script text, supports uid lookup and detects idempotency conflicts', async () => {
  const uid = `separated-${Date.now()}`;
  const body = {
    parameters: {
      uid,
      priority: 12,
      timeout_ms: 2000,
      log_level: 'debug',
      context: { delay_ms: 5 }
    },
    script_text: JSON.stringify({
      steps: [{ action: 'wait', params: { duration_ms: '{{delay_ms}}' }, timeout_ms: 200 }]
    })
  };
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': uid },
    body: JSON.stringify(body)
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.job.uid, uid);
  assert.equal(created.job.log_level, 'debug');

  const byUidResponse = await request(`/api/v2/jobs/by-uid/${encodeURIComponent(uid)}`);
  assert.equal(byUidResponse.status, 200);
  assert.equal((await byUidResponse.json()).job.job_id, created.job.job_id);

  const repeatedResponse = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': uid },
    body: JSON.stringify(body)
  });
  assert.equal(repeatedResponse.status, 200);
  assert.equal((await repeatedResponse.json()).idempotent, true);

  const conflictingBody = structuredClone(body);
  conflictingBody.parameters.priority = 13;
  const conflictResponse = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': uid },
    body: JSON.stringify(conflictingBody)
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error.code, 'IDEMPOTENCY_CONFLICT');

  const logsResponse = await request(`/api/v2/jobs/${created.job.job_id}/logs?min_level=debug`);
  const logs = await logsResponse.json();
  assert.equal(logs.log_level, 'debug');
  assert.ok(logs.logs.some((entry) => entry.level === 'debug'));
});

test('debug logging contains step diagnostics that are absent from info logging', async () => {
  const createAndWait = async (logLevel) => {
    const response = await request('/api/v2/jobs', {
      method: 'POST',
      body: JSON.stringify({
        uid: `logging-${logLevel}-${Date.now()}`,
        log_level: logLevel,
        script: {
          steps: [
            { id: 'pause', action: 'wait', params: { duration_ms: 5 } },
            { id: 'finish', action: 'noop', params: { marker: logLevel } }
          ]
        }
      })
    });
    assert.equal(response.status, 201);
    const jobId = (await response.json()).job.job_id;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const job = await request(`/api/v2/jobs/${jobId}`).then((jobResponse) => jobResponse.json()).then((body) => body.job);
      if (job.status === 'success') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return request(`/api/v2/jobs/${jobId}/logs`).then((logResponse) => logResponse.json());
  };

  const [debugLog, infoLog] = await Promise.all([
    createAndWait('debug'),
    createAndWait('info')
  ]);
  const debugEntries = debugLog.logs.filter((entry) => entry.level === 'debug');

  assert.ok(debugEntries.length >= 6, JSON.stringify(debugEntries));
  assert.ok(debugEntries.some((entry) => entry.message === 'Параметры шага 1/2 подготовлены'));
  assert.ok(debugEntries.some((entry) => entry.message === 'Результат шага 2/2 сохранён'));
  assert.ok(debugEntries.some((entry) => entry.message === 'Интерпретатор завершил сценарий'));
  assert.ok(debugEntries.some((entry) => entry.message === 'Итоговые данные задания сформированы'));
  assert.ok(debugLog.logs.length > infoLog.logs.length);
  assert.ok(infoLog.logs.every((entry) => entry.level !== 'debug'));
  assert.ok(infoLog.logs.some((entry) => entry.message === 'Шаг 1/2 запущен'));
  assert.ok(infoLog.logs.some((entry) => entry.message === 'Задание успешно выполнено'));
});

test('healthcheck reflects active and queued jobs on this UN', async () => {
  const createJob = async (uid) => {
    const response = await request('/api/v2/jobs', {
      method: 'POST',
      body: JSON.stringify({
        uid,
        script: { steps: [{ action: 'noop', duration_ms: 350 }] }
      })
    });
    return (await response.json()).job.job_id;
  };

  const firstJobId = await createJob(`health-running-${Date.now()}`);
  const secondJobId = await createJob(`health-queued-${Date.now()}`);
  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.equal(health.un_id, UN_ID);
  assert.deepEqual(health.queue, {
    status: 'busy',
    queued: 1,
    running: 1,
    max_parallel_jobs: 1,
    available_slots: 0
  });

  for (const jobId of [firstJobId, secondJobId]) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const job = await request(`/api/v2/jobs/${jobId}`).then((response) => response.json()).then((body) => body.job);
      if (job.status === 'success') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});

test('runs several jobs in parallel and exposes occupied capacity', async () => {
  const configResponse = await request('/api/v2/system/config', {
    method: 'PUT',
    body: JSON.stringify({ max_parallel_jobs: 3 })
  });
  assert.equal(configResponse.status, 200);

  try {
    const jobIds = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await request('/api/v2/jobs', {
        method: 'POST',
        body: JSON.stringify({
          uid: `parallel-${Date.now()}-${index}`,
          timeout_ms: 2000,
          script: { steps: [{ action: 'wait', params: { duration_ms: 300 }, timeout_ms: 1000 }] }
        })
      });
      jobIds.push((await response.json()).job.job_id);
    }

    let resources;
    const runningDeadline = Date.now() + 1000;
    while (Date.now() < runningDeadline) {
      resources = await request('/api/v2/system/resources').then((response) => response.json());
      if (resources.queue.queue_running === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(resources.queue.queue_running, 3);
    assert.equal(resources.queue.queue_max_parallel_jobs, 3);
    assert.equal(resources.queue.queue_available_slots, 0);

    for (const jobId of jobIds) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const job = await request(`/api/v2/jobs/${jobId}`).then((response) => response.json()).then((body) => body.job);
        if (job.status === 'success') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    await request('/api/v2/system/config', {
      method: 'PUT',
      body: JSON.stringify({ max_parallel_jobs: 1 })
    });
  }
});

test('serves the visual execution studio to an authenticated browser', async () => {
  const response = await webRequest('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Демо-маршрут этапа 4/);
  assert.match(html, /Экран браузера/);
  assert.match(html, /browser-live-frame/);
  assert.match(html, /Редактор сценариев/);
  assert.match(html, /Ход выполнения/);
});

test('serves ready-to-run demo scenarios to the studio', async () => {
  const response = await fetch(`${origin}/scenarios.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  const source = await response.text();
  assert.match(source, /Отчёт отправлен/);
  assert.match(source, /Повтор после сбоя/);
  assert.match(source, /Скачать файлы разных форматов/);
});

test('serves the deterministic Stage 4 demo document as a download', async () => {
  const response = await fetch(`${origin}/demo/files/stage4-download-demo.html`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.match(await response.text(), /Файл сохранён и открыт/);
});

test('serves non-HTML Stage 4 demo files with their declared formats', async () => {
  const fixtures = [
    ['stage4-report.xml', /application\/xml/, /<report/],
    ['stage4-result.json', /application\/json/, /"document"/],
    ['stage4-register.csv', /text\/csv/, /document_id;source/],
    ['stage4-log.txt', /text\/plain/, /Результат: SUCCESS/]
  ];
  for (const [filename, contentType, bodyPattern] of fixtures) {
    const response = await fetch(`${origin}/demo/files/${filename}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), contentType);
    assert.match(response.headers.get('content-disposition'), new RegExp(filename));
    assert.match(await response.text(), bodyPattern);
  }
});

test('serves the visual priority queue', async () => {
  const response = await webRequest('/queue');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Монитор выполнения JSON-сценариев/);
  assert.match(html, /CPU тестовой УН/);
  assert.match(html, /Параллельные слоты/);
});

test('logout invalidates the browser session', async () => {
  const loginResponse = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: WEB_LOGIN, password: WEB_PASSWORD })
  });
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const logoutResponse = await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie }
  });
  assert.equal(logoutResponse.status, 303);
  assert.equal(logoutResponse.headers.get('location'), '/login');

  const protectedResponse = await fetch(`${origin}/`, {
    redirect: 'manual',
    headers: { Cookie: cookie }
  });
  assert.equal(protectedResponse.status, 303);
});

test('exposes the interpreter action registry', async () => {
  const response = await request('/api/v2/interpreter/actions');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.actions.includes('find_files'));
  assert.ok(body.actions.includes('wait'));
  assert.ok(body.actions.includes('copy_files'));
  assert.ok(body.actions.includes('download_files'));
  assert.ok(body.actions.includes('open_file'));
  assert.ok(body.actions.includes('submit_if_valid'));
});

test('rejects invalid scripts before queueing them', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({ script: { steps: [{ action: 'not_registered' }] } })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_SCRIPT');
  assert.equal(body.error.details.errors[0].path, 'script.steps[0].action');
});

test('reports unresolved Replay templates as a normalized browser error', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      retry_policy: { max_attempts: 1, backoff_ms: 1 },
      script: {
        title: 'Missing context value',
        steps: [{ type: 'navigate', url: '{{missing_url}}' }]
      }
    })
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'BROWSER_REPLAY_ERROR');
  assert.match(job.error.message, /Не удалось подготовить Puppeteer Replay/);
});

test('rejects the real Yahoo demo before browser launch when its env password is missing', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      retry_policy: { max_attempts: 1, backoff_ms: 1 },
      script: {
        title: 'Yahoo secret check',
        steps: [{
          title: 'Ввести пароль Yahoo',
          description: 'Использует пароль только из окружения сервиса.',
          type: 'change',
          selectors: [['#login-passwd']],
          value: '{{yahoo_password}}'
        }]
      }
    })
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'MISSING_SECRET');
  assert.match(job.error.message, /YAHOO_MAIL_PASSWORD/);
});

test('executes a script through the API and exposes visual step state and logs', async () => {
  const externalUid = `integration-${Date.now()}`;
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: externalUid,
      timeout_ms: 5000,
      context: { root_dir: '/incoming', loaded_dir: '/loaded', download_dir: '/downloads' },
      script: {
        steps: [
          { action: 'find_files', params: { directory: '{{root_dir}}', files: ['FNS.xml'] }, duration_ms: 2 },
          { action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 2 },
          { action: 'validate_report', params: { valid: true }, duration_ms: 2 },
          { action: 'submit_if_valid', params: {}, duration_ms: 2 },
          {
            id: 'receipt',
            action: 'download_files',
            params: {
              destination: '{{download_dir}}',
              files: [{
                filename: 'receipt.pdf',
                source_url: 'https://example.test/receipt.pdf',
                mime_type: 'application/pdf',
                size_bytes: 128,
                checksum_sha256: 'abc123'
              }]
            },
            duration_ms: 2
          },
          { action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 2 }
        ]
      }
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  const jobId = created.job.job_id;

  let job;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await request(`/api/v2/jobs/${jobId}`);
    job = (await response.json()).job;
    if (['success', 'failed', 'validation_failed', 'timeout'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(job.status, 'success');
  assert.equal(job.un_id, UN_ID);
  assert.equal(job.execution.percent, 100);
  assert.equal(job.execution.completed_steps, 6);
  assert.ok(job.execution.steps.every((step) => step.status === 'success'));
  assert.deepEqual(job.execution.context.uploaded_files, ['FNS.xml']);
  assert.deepEqual(job.result.artifacts, [
    `/api/v2/jobs/${jobId}/artifacts/receipt_1`
  ]);
  assert.deepEqual(Object.keys(job.result).filter((key) => key !== 'artifacts'), []);

  const logResponse = await request(`/api/v2/jobs/${jobId}/logs`);
  const logBody = await logResponse.json();
  assert.ok(logBody.logs.some((entry) => entry.message === 'Шаг 1/6 запущен'));
  assert.ok(logBody.logs.some((entry) => entry.message === 'Задание успешно выполнено'));
});

test('retries retryable normalized errors using the job policy', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      retry_policy: { max_attempts: 2, backoff_ms: 5 },
      script: { steps: [{ action: 'auth_ecp', params: { plugin_running: false } }] }
    })
  });
  const jobId = (await response.json()).job.job_id;
  let job;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 2);
  assert.equal(job.error.code, 'PLUGIN_NOT_RUNNING');
});

test('returns a terminal result to 1C callback with retries and delivery state', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `callback-${Date.now()}`,
      timeout_ms: 2000,
      callback: {
        url: `${origin}/demo/1c/callback?fail_once=callback-test`,
        max_attempts: 3,
        backoff_ms: 10,
        timeout_ms: 500
      },
      script: {
        context: { delay_ms: 20 },
        steps: [{ action: 'wait', params: { duration_ms: '{{delay_ms}}' }, timeout_ms: 200 }]
      }
    })
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.callback_delivery?.status === 'delivered') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(job.status, 'success');
  assert.equal(job.execution.context.waited_ms, 20);
  assert.equal(job.callback_delivery.status, 'delivered');
  assert.equal(job.callback_delivery.attempts, 2);
  assert.equal(job.callback_delivery.last_http_status, 204);
  assert.equal(job.callback_delivery.last_response_body, '');
  assert.equal(job.callback_delivery.last_response_body_truncated, false);
  assert.equal(job.callback_delivery.response_history.length, 2);
  assert.equal(job.callback_delivery.response_history[0].http_status, 503);
  assert.match(job.callback_delivery.response_history[0].content_type, /^application\/json/);
  assert.match(job.callback_delivery.response_history[0].body, /DEMO_CALLBACK_FAILURE/);
  assert.equal(job.callback_delivery.response_history[0].body_truncated, false);
  assert.equal(job.callback_delivery.response_history[1].http_status, 204);
  assert.equal(job.callback_delivery.response_history[1].body, '');
  const callbackEvents = await request('/api/v2/demo/callback-events').then((eventResponse) => eventResponse.json());
  const delivered = callbackEvents.items.at(-1);
  assert.equal(delivered.event, 'job.completed');
  assert.equal(delivered.job.job_id, jobId);
  assert.deepEqual(delivered.job.result, { artifacts: [] });
});

test('stores the response body when a 1C callback is rejected with HTTP 402', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `callback-402-${Date.now()}`,
      timeout_ms: 2000,
      callback: {
        url: `${origin}/demo/1c/callback?response_status=402`,
        max_attempts: 1,
        timeout_ms: 500
      },
      script: { steps: [{ action: 'noop' }] }
    })
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.callback_delivery?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(job.status, 'success');
  assert.equal(job.callback_delivery.status, 'failed');
  assert.equal(job.callback_delivery.last_http_status, 402);
  assert.match(job.callback_delivery.last_response_content_type, /^application\/json/);
  assert.match(job.callback_delivery.last_response_body, /DEMO_CALLBACK_REJECTED/);
  assert.equal(job.callback_delivery.last_response_body_truncated, false);
  assert.equal(job.callback_delivery.response_history.length, 1);
  assert.equal(job.callback_delivery.error.http_status, 402);
  assert.equal(job.callback_delivery.error.response_body, job.callback_delivery.last_response_body);
});

test('cancels an active interpreter step through its abort signal', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      script: { steps: [{ action: 'noop', duration_ms: 1000 }] }
    })
  });
  const jobId = (await response.json()).job.job_id;
  const cancelResponse = await request(`/api/v2/jobs/${jobId}/cancel`, { method: 'POST' });
  assert.ok([200, 202].includes(cancelResponse.status));

  let job;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(job.status, 'cancelled');
  assert.equal(job.error.code, 'CANCELLED');
  assert.equal(job.execution.status, 'cancelled');
});

test('downloads, saves, verifies and opens the Stage 4 demo file', async () => {
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `download-open-${Date.now()}`,
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, backoff_ms: 5 },
      script: {
        default_step_timeout_ms: 15000,
        steps: [
          {
            id: 'download',
            title: 'Скачать и сохранить документ',
            description: 'Загружает встроенный документ по HTTP.',
            action: 'download_files',
            params: {
              save: true,
              files: [{ filename: 'stage4-demo-document.html', source_url: '{{demo_file_url}}' }]
            }
          },
          {
            title: 'Проверить файл',
            description: 'Читает сохранённую копию с диска.',
            action: 'read_text_file',
            params: { path: '{{downloaded_files.0}}' }
          },
          {
            title: 'Открыть файл',
            description: 'Открывает сохранённую копию в Chromium.',
            action: 'open_file',
            params: { path: '{{downloaded_files.0}}' }
          }
        ]
      }
    })
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (['success', 'failed', 'validation_failed', 'timeout'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(job.status, 'success', JSON.stringify(job.error));
  assert.match(job.execution.context.file_content, /Файл сохранён и открыт/);
  assert.match(job.execution.context.opened_url, /^file:/);
  assert.equal(job.result.artifacts.length, 2);
  assert.ok(job.result.artifacts.every((item) => typeof item === 'string' && item.startsWith('/api/v2/jobs/')));

  for (const apiUrl of job.result.artifacts) {
    const artifactResponse = await request(apiUrl);
    assert.equal(artifactResponse.status, 200, apiUrl);
    assert.ok((await artifactResponse.arrayBuffer()).byteLength > 1000, apiUrl);
  }
  const downloadedApiUrl = job.result.artifacts[0];
  const downloadedResponse = await webRequest(`/artifacts/${jobId}/stage4-demo-document.html`);
  assert.equal(downloadedResponse.status, 200);
  assert.match(await downloadedResponse.text(), /DOWNLOAD → SAVE → VERIFY → OPEN/);
});

test('keeps partial artifacts and diagnostic logs after a controlled file-flow failure', async () => {
  const uid = `download-error-${Date.now()}`;
  const payload = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, '../demo/download-save-open2.json'),
    'utf8'
  ));
  payload.uid = uid;
  payload.callback.url = `${origin}/demo/1c/callback?case=download-save-open2`;
  payload.callback.backoff_ms = 5;
  payload.callback.timeout_ms = 500;
  const response = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': uid },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 201);
  const jobId = (await response.json()).job.job_id;

  let job;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    job = await request(`/api/v2/jobs/${jobId}`).then((jobResponse) => jobResponse.json()).then((body) => body.job);
    if (job.status === 'validation_failed' && job.callback_delivery?.status === 'delivered') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(job.status, 'validation_failed');
  assert.equal(job.callback_delivery.status, 'delivered');
  assert.equal(job.error.code, 'VALIDATION_ERROR');
  assert.match(job.error.message, /download-save-open2/);
  assert.equal(job.result.artifacts.length, 2);
  assert.ok(job.result.artifacts.every((item) => typeof item === 'string' && item.startsWith('/api/v2/jobs/')));

  const callbackEvents = await request('/api/v2/demo/callback-events').then((eventResponse) => eventResponse.json());
  const callbackEvent = callbackEvents.items.find((event) => event.job.uid === uid);
  assert.equal(callbackEvent.job.error.code, 'VALIDATION_ERROR');
  assert.equal(callbackEvent.job.result.artifacts.length, 2);

  const errorLogs = await request(`/api/v2/jobs/${jobId}/logs?min_level=error`).then((logResponse) => logResponse.json());
  assert.ok(errorLogs.logs.length >= 1);
  assert.ok(errorLogs.logs.every((entry) => entry.level === 'error'));
});

test('executes a local Puppeteer Replay mail fixture without external delivery', async () => {
  const flow = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, './fixtures/browser-replay-local-mail.json'),
    'utf8'
  ));
  const subject = `Browser E2E ${Date.now()}`;
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `browser-e2e-${Date.now()}`,
      timeout_ms: 45000,
      retry_policy: { max_attempts: 1, backoff_ms: 5 },
      context: {
        mail_to: 'integration-recipient@example.test',
        mail_subject: subject,
        mail_body: 'Это письмо отправлено сквозным тестом через Chrome Recorder JSON.'
      },
      script: flow
    })
  });
  assert.equal(createResponse.status, 201);
  const jobId = (await createResponse.json()).job.job_id;

  let job;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (['success', 'failed', 'validation_failed', 'timeout'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(job.status, 'success', JSON.stringify(job.error));
  assert.equal(job.execution.completed_steps, 18);
  assert.ok(job.execution.steps.every((step) => step.status === 'success'));
  assert.ok(job.execution.steps.every((step) => step.title && step.description));
  assert.deepEqual(job.execution.steps.slice(0, 3).map((step) => step.action), [
    'setViewport', 'navigate', 'waitForElement'
  ]);
  const passwordStep = job.execution.steps.find((step) => step.action === 'change'
    && JSON.stringify(step.params?.selectors).includes('mail-password'));
  assert.equal(passwordStep.params.value, '••••••');
  assert.doesNotMatch(JSON.stringify(job), new RegExp(DEMO_MAIL_PASSWORD));

  const screenshotApiUrl = job.result.artifacts[0];
  assert.ok(typeof screenshotApiUrl === 'string' && screenshotApiUrl.startsWith('/api/v2/jobs/'), JSON.stringify(job.result));
  const screenshotResponse = await request(screenshotApiUrl);
  assert.equal(screenshotResponse.status, 200);
  assert.equal(screenshotResponse.headers.get('content-type'), 'image/png');
  assert.ok((await screenshotResponse.arrayBuffer()).byteLength > 1000);

  const mailLogin = await fetch(`${origin}/demo/mail/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: DEMO_MAIL_LOGIN, password: DEMO_MAIL_PASSWORD })
  });
  assert.equal(mailLogin.status, 200);
  const mailCookie = mailLogin.headers.get('set-cookie').split(';')[0];
  const mailState = await fetch(`${origin}/demo/mail/api/state`, {
    headers: { Cookie: mailCookie }
  }).then((response) => response.json());
  const sentMessage = mailState.messages.find((message) => message.subject === subject);
  assert.ok(sentMessage);
  assert.equal(sentMessage.to, 'integration-recipient@example.test');
  assert.match(sentMessage.body, /Chrome Recorder JSON/);
});

test('executes both multi-job queue demo cases with the expected scheduling semantics', async () => {
  const filenames = ['queue-case-priority-error.json', 'queue-case-running-low.json'];
  const caseRequest = async (pathname, options = {}) => {
    const response = await request(pathname, options);
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  };

  for (const filename of filenames) {
    const definition = JSON.parse(await readFile(path.resolve(import.meta.dirname, `../demo/${filename}`), 'utf8'));
    const result = await runQueueCase(definition, {
      request: caseRequest,
      pollIntervalMs: 20,
      runId: `integration-${Date.now()}`
    });
    assert.equal(result.passed, true, result.checks.map((check) => `${check.passed}: ${check.message}`).join('\n'));
  }
});

test('deletes a finished job together with its artifact files', async () => {
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `delete-${Date.now()}`,
      timeout_ms: 15000,
      script: {
        steps: [
          {
            id: 'download',
            action: 'download_files',
            params: {
              save: true,
              files: [{ filename: 'delete-me.html', source_url: '{{demo_file_url}}' }]
            }
          }
        ]
      }
    })
  });
  assert.equal(createResponse.status, 201);
  const jobId = (await createResponse.json()).job.job_id;

  let job;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (['success', 'failed', 'validation_failed', 'timeout'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(job.status, 'success', JSON.stringify(job.error));
  assert.equal(job.result.artifacts.length, 1);

  const artifactApiUrl = job.result.artifacts[0];
  const artifactResponse = await request(artifactApiUrl);
  assert.equal(artifactResponse.status, 200);

  const jobArtifactsDir = path.join(dataDir, 'artifacts', jobId);
  assert.ok((await readdir(jobArtifactsDir)).length > 0);

  const deleteResponse = await request(`/api/v2/jobs/${jobId}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  const deleteBody = await deleteResponse.json();
  assert.equal(deleteBody.deleted, true);
  assert.equal(deleteBody.job_id, jobId);
  assert.equal(deleteBody.artifacts_removed, true);

  const getAfterDelete = await request(`/api/v2/jobs/${jobId}`);
  assert.equal(getAfterDelete.status, 404);
  assert.equal((await getAfterDelete.json()).error.code, 'JOB_NOT_FOUND');

  const artifactAfterDelete = await request(artifactApiUrl);
  assert.equal(artifactAfterDelete.status, 404);

  await assert.rejects(() => readdir(jobArtifactsDir), /ENOENT/);
});

test('refuses to delete a running job and deletes it after cancellation', async () => {
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      script: { steps: [{ action: 'noop', duration_ms: 2000 }] }
    })
  });
  const jobId = (await createResponse.json()).job.job_id;

  const busyDelete = await request(`/api/v2/jobs/${jobId}`, { method: 'DELETE' });
  assert.equal(busyDelete.status, 409);
  assert.equal((await busyDelete.json()).error.code, 'JOB_IN_PROGRESS');

  const cancelResponse = await request(`/api/v2/jobs/${jobId}/cancel`, { method: 'POST' });
  assert.ok([200, 202].includes(cancelResponse.status));

  let job;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    job = (await (await request(`/api/v2/jobs/${jobId}`)).json()).job;
    if (job.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, 'cancelled');

  const deleteResponse = await request(`/api/v2/jobs/${jobId}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).deleted, true);
  assert.equal((await (await request(`/api/v2/jobs/${jobId}`)).json()).error.code, 'JOB_NOT_FOUND');
});

test('returns 404 when deleting an unknown job', async () => {
  const response = await request('/api/v2/jobs/does-not-exist', { method: 'DELETE' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'JOB_NOT_FOUND');
});
