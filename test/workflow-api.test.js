import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

test('dynamic workflow steps and result survive an API worker restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-api-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  const stop = async () => { if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; } };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore',
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), API_KEY: 'workflow-test-key', UN_ID: 'workflow-test', WEB_LOGIN: 'test', WEB_PASSWORD: 'test', DATA_DIR: root } });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not start');
  };
  const request = async (url, body) => fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { 'X-API-Key': 'workflow-test-key', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await start();
  const script = { format: 'json-workflow', steps: [
    { action: 'for_each', as: 'item', params: { items: [1, 2] }, steps: [{ action: 'wait', params: { duration_ms: 1 }, title: 'nested item' }] },
    { action: 'set', params: { result: { ok: true } } }
  ], output: { Rezult_1: '{{result}}' } };
  const response = await request('/api/v2/jobs', { script, timeout_ms: 5000 });
  assert.equal(response.status, 201);
  const id = (await response.json()).job.job_id;
  let job;
  const deadline = Date.now() + 5000;
  do {
    job = (await (await request(`/api/v2/jobs/${id}`)).json()).job;
    if (job.status === 'success') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(job.status, 'success');
  assert.equal(job.execution.steps.length, 4);
  await stop();
  await start();
  const restored = (await (await request(`/api/v2/jobs/${id}`)).json()).job;
  assert.equal(restored.execution.steps.length, 4);
  assert.equal(restored.execution.completed_steps, 4);
  assert.equal(restored.execution.steps.filter(step => step.title === 'nested item').length, 2);
  assert.deepEqual(restored.result.Rezult_1, { ok: true });
});
