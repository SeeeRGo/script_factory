import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const username = 'callback-user-unique';
const password = 'callback-password-unique';
const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const token = 'callback-token-unique';

async function receiver(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function service(t, env = {}, expectFailure = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'callback-auth-'));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      API_KEY: 'callback-test-api-key',
      UN_ID: 'callback-test-un',
      WEB_LOGIN: 'callback-test-web-user',
      WEB_PASSWORD: 'callback-test-web-password',
      DATA_DIR: dataDir,
      CALLBACK_AUTH_TOKEN: '',
      CALLBACK_AUTH_USERNAME: '',
      CALLBACK_AUTH_PASSWORD: '',
      CALLBACK_ALLOWED_ORIGINS: '',
      DEMO_1C_CALLBACK_ENABLED: 'false',
      PERSIST_DEBOUNCE_MS: '1',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timeout);
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !output.includes('script-factory listening') && child.exitCode === null) {
    await delay(20);
  }
  if (expectFailure) {
    assert.notEqual(child.exitCode, null, output);
    assert.notEqual(child.exitCode, 0);
    return output;
  }
  assert.match(output, /script-factory listening/, output);
  const request = (pathname, body) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-API-Key': 'callback-test-api-key', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { request, dataDir, child, exited };
}

async function submit(app, callback, extra = {}) {
  return app.request('/api/v2/jobs', {
    script: { steps: [], simulate: { delay_ms: 0 } },
    callback: { max_attempts: 1, ...callback },
    ...extra
  });
}

async function completed(app, response) {
  assert.equal(response.status, 201, await response.clone().text());
  const { job } = await response.json();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await (await app.request(`/api/v2/jobs/${job.job_id}`)).json();
    if (['delivered', 'failed'].includes(result.job.callback_delivery.status)) return result.job;
    await delay(20);
  }
  assert.fail('Callback did not complete');
}

for (const [name, env, authorization, secrets] of [
  ['Basic', { CALLBACK_AUTH_USERNAME: username, CALLBACK_AUTH_PASSWORD: password }, basic, [username, password, basic, basic.slice(6)]],
  ['Bearer', { CALLBACK_AUTH_TOKEN: token }, `Bearer ${token}`, [token, `Bearer ${token}`]]
]) {
  test(`${name} sends env auth only to allowlisted receiver and redacts captured history, errors and persisted state`, async (t) => {
    const received = [];
    const origin = await receiver(t, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ auth: req.headers.authorization, body });
      res.writeHead(received.length === 1 ? 503 : 200, { 'Content-Type': `text/plain; reflected="${authorization}"` });
      res.end(`response retained: ${secrets.join(' | ')} | ${secrets.map(encodeURIComponent).join(' | ')}`);
    });
    const app = await service(t, { ...env, CALLBACK_ALLOWED_ORIGINS: origin });
    const job = await completed(app, await submit(app, { url: `${origin}/callback`, max_attempts: 2, backoff_ms: 1 }));
    assert.equal(job.callback_delivery.status, 'delivered');
    assert.equal(job.callback_delivery.response_history.length, 2);
    assert.deepEqual(job.callback_delivery.response_history.map((entry) => entry.http_status), [503, 200]);
    assert.match(job.callback_delivery.last_response_body, /response retained/);
    assert.match(job.callback_delivery.last_response_body, /\[REDACTED\]/);
    assert.equal(job.callback_delivery.last_response_body_truncated, false);
    assert.equal(received.length, 2);
    for (const request of received) {
      assert.equal(request.auth, authorization);
      for (const secret of secrets) assert.ok(!request.body.includes(secret));
      assert.equal(JSON.parse(request.body).event, 'job.completed');
    }
    const logs = await (await app.request(`/api/v2/jobs/${job.job_id}/logs`)).text();
    const serialized = JSON.stringify(job) + logs;
    for (const secret of secrets) assert.ok(!serialized.includes(secret));
    app.child.kill('SIGTERM');
    await app.exited;
    const db = new DatabaseSync(path.join(app.dataDir, 'state.sqlite'), { readOnly: true });
    try {
      const snapshot = db.prepare('SELECT snapshot_json FROM jobs WHERE job_id = ?').get(job.job_id).snapshot_json;
      for (const secret of secrets) assert.ok(!snapshot.includes(secret));
      assert.equal(JSON.parse(snapshot).callback_delivery.response_history.length, 2);
    } finally {
      db.close();
    }
  });
}

test('redirects fail without forwarding authorization or making a second request', async (t) => {
  let targetRequests = 0;
  let sourceRequests = 0;
  const target = await receiver(t, (req, res) => {
    targetRequests += 1;
    res.end('must not be requested');
  });
  const origin = await receiver(t, (req, res) => {
    sourceRequests += 1;
    assert.equal(req.headers.authorization, basic);
    res.writeHead(307, { Location: `${target}/forwarded` });
    res.end();
  });
  const app = await service(t, {
    CALLBACK_AUTH_USERNAME: username,
    CALLBACK_AUTH_PASSWORD: password,
    CALLBACK_ALLOWED_ORIGINS: `${origin},${target}`
  });
  const job = await completed(app, await submit(app, { url: `${origin}/redirect` }));
  assert.equal(job.callback_delivery.status, 'failed');
  assert.equal(job.callback_delivery.error.code, 'CALLBACK_DELIVERY_ERROR');
  assert.equal(sourceRequests, 1);
  assert.equal(targetRequests, 0);
});

test('rejects URL credentials, unsafe schemes, nonliteral HTTP loopback, and unlisted origins before accepting jobs', async (t) => {
  const app = await service(t, { CALLBACK_AUTH_TOKEN: token, CALLBACK_ALLOWED_ORIGINS: 'https://callback.example' });
  for (const url of [
    'https://user:password@callback.example/callback',
    'https://user@callback.example/callback',
    'https://@callback.example/callback',
    'https://callback.example/callback?username=user&password=secret',
    'https://callback.example/callback?token=secret',
    `https://callback.example/${token}`,
    'http://callback.example/callback',
    'http://localhost/callback',
    'http://127.1/callback',
    'http://2130706433/callback',
    'http://127.0.0.1/callback',
    'https://callback.example.evil/callback',
    'https://callback.example:444/callback',
    'file:///callback',
    'not-a-url'
  ]) {
    const response = await submit(app, { url });
    assert.equal(response.status, 400, url);
    assert.equal((await response.json()).error.code, 'INVALID_PAYLOAD');
  }
  assert.equal((await (await app.request('/api/v2/jobs')).json()).total, 0);
});

test('rejects inline callback auth rather than persisting request credentials', async (t) => {
  const app = await service(t);
  for (const callback of [
    { username, password },
    { auth: { username, password } },
    { auth_username: username, auth_password: password },
    { token },
    { headers: { Authorization: basic } }
  ]) {
    const response = await submit(app, { url: 'https://callback.example', ...callback });
    assert.equal(response.status, 400);
    const body = await response.text();
    for (const secret of [username, password, token, basic]) assert.ok(!body.includes(secret));
  }
  assert.equal((await (await app.request('/api/v2/jobs')).json()).total, 0);
});

test('unauthenticated literal-loopback callback preserves bounded response capture', async (t) => {
  const origin = await receiver(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('a'.repeat(20 * 1024));
  });
  const app = await service(t);
  const job = await completed(app, await submit(app, { url: origin }));
  assert.equal(job.callback_delivery.status, 'failed');
  assert.equal(job.callback_delivery.last_response_body.length, 16 * 1024);
  assert.equal(job.callback_delivery.last_response_body_truncated, true);
  assert.equal(job.callback_delivery.error.response_body, job.callback_delivery.last_response_body);
  assert.equal(job.callback_delivery.response_history.length, 1);
});

test('redacts a configured secret cut by the response capture limit', async (t) => {
  const origin = await receiver(t, (req, res) => {
    res.end(`${'x'.repeat(16 * 1024 - 8)}${password}`);
  });
  const app = await service(t, {
    CALLBACK_AUTH_USERNAME: username,
    CALLBACK_AUTH_PASSWORD: password,
    CALLBACK_ALLOWED_ORIGINS: origin
  });
  const job = await completed(app, await submit(app, { url: origin }));
  assert.equal(job.callback_delivery.last_response_body_truncated, true);
  assert.ok(job.callback_delivery.last_response_body.endsWith('[REDACTED]'));
  assert.ok(!job.callback_delivery.last_response_body.includes(password.slice(0, 8)));
});

test('fails startup on ambiguous, partial, unsafe or unallowlisted auth configuration without leaking values', async (t) => {
  for (const env of [
    { CALLBACK_AUTH_TOKEN: token, CALLBACK_AUTH_USERNAME: username, CALLBACK_AUTH_PASSWORD: password },
    { CALLBACK_AUTH_USERNAME: username },
    { CALLBACK_AUTH_PASSWORD: password },
    { CALLBACK_AUTH_TOKEN: token },
    { CALLBACK_AUTH_USERNAME: username, CALLBACK_AUTH_PASSWORD: password },
    { CALLBACK_AUTH_TOKEN: token, CALLBACK_ALLOWED_ORIGINS: 'http://callback.example' },
    { CALLBACK_AUTH_TOKEN: token, CALLBACK_ALLOWED_ORIGINS: 'https://user:password@callback.example' },
    { CALLBACK_AUTH_TOKEN: token, CALLBACK_ALLOWED_ORIGINS: 'https://callback.example/path' },
    { CALLBACK_AUTH_TOKEN: token, CALLBACK_ALLOWED_ORIGINS: 'https://callback.example?token=secret' },
    { CALLBACK_AUTH_USERNAME: 'invalid:user', CALLBACK_AUTH_PASSWORD: password, CALLBACK_ALLOWED_ORIGINS: 'https://callback.example' },
    { CALLBACK_AUTH_TOKEN: `${token}\r\ninvalid`, CALLBACK_ALLOWED_ORIGINS: 'https://callback.example' }
  ]) {
    const output = await service(t, env, true);
    assert.match(output, /CALLBACK_AUTH|CALLBACK_ALLOWED_ORIGINS/);
    for (const secret of [username, password, token, basic]) assert.ok(!output.includes(secret));
  }
});
