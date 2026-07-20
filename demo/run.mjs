import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDemoData } from './reset.mjs';

const scenario = process.argv[2] || 'success';
const expected = {
  success: { status: 'success' },
  'file-not-found': { status: 'failed', code: 'FILE_NOT_FOUND' },
  retry: { status: 'success', attempts: 2 },
  timeout: { status: 'timeout', code: 'TIMEOUT_ERROR' }
};

if (!expected[scenario]) {
  console.error(`Неизвестный сценарий: ${scenario}. Доступны: ${Object.keys(expected).join(', ')}`);
  process.exit(2);
}

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(demoDirectory);
const apiUrl = process.env.DEMO_API_URL || 'http://127.0.0.1:3000';
const apiKey = process.env.API_KEY || 'dev-secret';
const payload = JSON.parse(await readFile(path.join(demoDirectory, `${scenario}.json`), 'utf8'));
const terminalStatuses = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);

await resetDemoData();
console.log(`Сценарий: ${scenario}`);
console.log(`API: ${apiUrl}`);

const createResponse = await fetch(`${apiUrl}/api/v2/jobs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'Idempotency-Key': `demo-${scenario}-${Date.now()}`
  },
  body: JSON.stringify(payload)
});

if (!createResponse.ok) {
  console.error('Не удалось создать задание:', createResponse.status, await createResponse.text());
  process.exit(1);
}

let job = (await createResponse.json()).job;
let shownLogs = 0;
let previousStatus;
console.log(`Создано задание ${job.job_id}`);

while (!terminalStatuses.has(job.status)) {
  if (job.status !== previousStatus) {
    console.log(`Статус: ${job.status}; попытка: ${job.attempts}`);
    previousStatus = job.status;
  }

  const logsResponse = await fetch(`${apiUrl}/api/v2/jobs/${job.job_id}/logs`, {
    headers: { 'X-API-Key': apiKey }
  });
  const logs = (await logsResponse.json()).logs;
  for (const entry of logs.slice(shownLogs)) {
    console.log(`[${entry.level}] ${entry.message}`);
  }
  shownLogs = logs.length;

  await new Promise((resolve) => setTimeout(resolve, 150));
  const jobResponse = await fetch(`${apiUrl}/api/v2/jobs/${job.job_id}`, {
    headers: { 'X-API-Key': apiKey }
  });
  job = (await jobResponse.json()).job;
}

const finalLogsResponse = await fetch(`${apiUrl}/api/v2/jobs/${job.job_id}/logs`, {
  headers: { 'X-API-Key': apiKey }
});
const finalLogs = (await finalLogsResponse.json()).logs;
for (const entry of finalLogs.slice(shownLogs)) {
  console.log(`[${entry.level}] ${entry.message}`);
}

console.log('Итог:', JSON.stringify(job, null, 2));
if (scenario === 'success') {
  console.log('Файлы в demo-data/loaded:', await readdir(path.join(projectDirectory, 'demo-data', 'loaded')));
}

const expectation = expected[scenario];
const matches = job.status === expectation.status
  && (!expectation.code || job.error?.code === expectation.code)
  && (!expectation.attempts || job.attempts === expectation.attempts);

if (!matches) {
  console.error('Результат не совпал с ожидаемым:', expectation);
  process.exit(1);
}

console.log('Сценарий завершён ожидаемым результатом.');
