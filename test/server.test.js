import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const API_KEY = 'integration-secret';
const WEB_LOGIN = 'integration-user';
const WEB_PASSWORD = 'integration-password';
const PORT = 36000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${PORT}`;
let child;
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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'script-factory-test-'));
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      API_KEY,
      WEB_LOGIN,
      WEB_PASSWORD,
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

test('serves the visual execution studio to an authenticated browser', async () => {
  const response = await webRequest('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Демо-маршрут на 12 минут/);
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
});

test('serves the visual priority queue', async () => {
  const response = await webRequest('/queue');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Монитор выполнения JSON-сценариев/);
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

test('executes a script through the API and exposes visual step state and logs', async () => {
  const createResponse = await request('/api/v2/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uid: `integration-${Date.now()}`,
      timeout_ms: 5000,
      context: { root_dir: '/incoming', loaded_dir: '/loaded' },
      script: {
        steps: [
          { action: 'find_files', params: { directory: '{{root_dir}}', files: ['FNS.xml'] }, duration_ms: 2 },
          { action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 2 },
          { action: 'validate_report', params: { valid: true }, duration_ms: 2 },
          { action: 'submit_if_valid', params: {}, duration_ms: 2 },
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
  assert.equal(job.execution.percent, 100);
  assert.equal(job.execution.completed_steps, 5);
  assert.ok(job.execution.steps.every((step) => step.status === 'success'));
  assert.deepEqual(job.result.context.uploaded_files, ['FNS.xml']);

  const logResponse = await request(`/api/v2/jobs/${jobId}/logs`);
  const logBody = await logResponse.json();
  assert.ok(logBody.logs.some((entry) => entry.message === 'Шаг 1/5 запущен'));
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
