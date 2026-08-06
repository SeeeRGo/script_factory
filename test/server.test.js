import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const API_KEY = 'integration-secret';
const WEB_LOGIN = 'integration-user';
const WEB_PASSWORD = 'integration-password';
const UN_ID = 'un-integration-01';
const DEMO_MAIL_LOGIN = 'browser-demo-user';
const DEMO_MAIL_PASSWORD = 'browser-demo-password';
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
      UN_ID,
      WEB_LOGIN,
      WEB_PASSWORD,
      DEMO_MAIL_LOGIN,
      DEMO_MAIL_PASSWORD,
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      BROWSER_HEADLESS: 'true',
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
    assert.equal(body.un_id, UN_ID);
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
  assert.deepEqual(resources.queue, {
    status: 'idle',
    queued: 0,
    running: 0,
    max_parallel_jobs: 1,
    available_slots: 1
  });
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

test('serves the visual execution studio to an authenticated browser', async () => {
  const response = await webRequest('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Демо-маршрут этапа 3/);
  assert.match(html, /Экран Chromium/);
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
  assert.ok(body.actions.includes('download_files'));
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
  assert.deepEqual(job.result.context.uploaded_files, ['FNS.xml']);
  assert.equal(job.result.job_id, jobId);
  assert.equal(job.result.uid, externalUid);
  assert.equal(job.result.un_id, UN_ID);
  assert.equal(job.result.artifacts.length, 1);
  const { created_at: artifactCreatedAt, ...artifact } = job.result.artifacts[0];
  assert.deepEqual(artifact, {
    artifact_id: 'receipt_1',
    kind: 'downloaded_file',
    filename: 'receipt.pdf',
    local_path: '/downloads/receipt.pdf',
    source_url: 'https://example.test/receipt.pdf',
    mime_type: 'application/pdf',
    size_bytes: 128,
    checksum_sha256: 'abc123'
  });
  assert.ok(Number.isFinite(Date.parse(artifactCreatedAt)));

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

test('executes an exported Puppeteer Replay flow and sends a real demo email', async () => {
  const flow = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, '../demo/browser-replay-send-email.json'),
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
  assert.equal(job.result.runtime, 'puppeteer-replay');
  assert.equal(job.result.steps_executed, 18);
  assert.equal(job.execution.completed_steps, 18);
  assert.ok(job.execution.steps.every((step) => step.status === 'success'));
  assert.deepEqual(job.execution.steps.slice(0, 3).map((step) => step.action), [
    'setViewport', 'navigate', 'waitForElement'
  ]);
  const passwordStep = job.execution.steps.find((step) => step.action === 'change'
    && JSON.stringify(step.params?.selectors).includes('mail-password'));
  assert.equal(passwordStep.params.value, '••••••');
  assert.doesNotMatch(JSON.stringify(job), new RegExp(DEMO_MAIL_PASSWORD));

  const screenshot = job.result.artifacts.find((artifact) => artifact.kind === 'browser_screenshot');
  assert.ok(screenshot);
  assert.equal(screenshot.mime_type, 'image/png');
  assert.ok(screenshot.size_bytes > 1000);

  const artifactResponse = await webRequest(screenshot.public_url);
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get('content-type'), 'image/png');
  assert.ok((await artifactResponse.arrayBuffer()).byteLength > 1000);

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
