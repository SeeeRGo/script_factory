import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');

test('removes expired jobs, logs, results and artifacts on startup', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'job-retention-'));
  const jobId = 'job_expired';
  const artifactDir = path.join(dataDir, 'artifacts', jobId);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'old-result.txt'), 'expired');

  const timestamp = '2020-01-01T00:00:00.000Z';
  const snapshot = {
    job_id: jobId,
    uid: 'expired-job',
    status: 'success',
    request: { script: { steps: [] } },
    created_at: timestamp,
    updated_at: timestamp,
    finished_at: timestamp,
    result: { artifacts: [] },
    logs: [{ ts: timestamp, level: 'info', message: 'old log' }]
  };
  const database = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
  database.exec(`
    CREATE TABLE app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.prepare('INSERT INTO app_config VALUES (1, ?, ?)').run(JSON.stringify({ job_retention_days: 30 }), timestamp);
  database.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(jobId, snapshot.uid, JSON.stringify(snapshot), timestamp);
  database.close();

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
      API_KEY: 'retention-test-key',
      UN_ID: 'retention-test-un',
      WEB_LOGIN: 'retention-test-user',
      WEB_PASSWORD: 'retention-test-password',
      DATA_DIR: dataDir
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
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 8000;
  while (!output.includes('script-factory listening') && child.exitCode === null && Date.now() < deadline) {
    await delay(20);
  }
  assert.match(output, /Cleaned up 1 expired job\(s\)/, output);
  assert.match(output, /script-factory listening/, output);

  const response = await fetch(`http://127.0.0.1:${port}/api/v2/jobs/${jobId}`, {
    headers: { 'X-API-Key': 'retention-test-key' }
  });
  assert.equal(response.status, 404);
  await assert.rejects(access(artifactDir), /ENOENT/);

  const persisted = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
  assert.equal(persisted.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  persisted.close();
});
