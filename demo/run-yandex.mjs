import { readFile } from 'node:fs/promises';

const API_URL = process.env.DEMO_API_URL || 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY || 'dev-secret';
const flow = JSON.parse(await readFile(new URL('./browser-replay-yandex-search.json', import.meta.url), 'utf8'));
const suffix = Date.now();

const response = await fetch(`${API_URL}/api/v2/jobs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
  body: JSON.stringify({
    uid: `stage3-yandex-${suffix}`,
    priority: 6,
    timeout_ms: 30000,
    retry_policy: { max_attempts: 1, backoff_ms: 500 },
    context: { search_query: 'официальная документация Node.js' },
    script: flow
  })
});

const created = await response.json();
if (!response.ok) throw new Error(JSON.stringify(created, null, 2));
const jobId = created.job.job_id;
console.log(`Создано задание ${jobId}`);

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const jobResponse = await fetch(`${API_URL}/api/v2/jobs/${jobId}`, {
    headers: { 'X-API-Key': API_KEY }
  });
  const { job } = await jobResponse.json();
  console.log(`${job.status.padEnd(18)} ${String(job.execution.percent).padStart(3)}% · ${job.execution.completed_steps}/${job.execution.total_steps}`);
  if (['success', 'failed', 'validation_failed', 'cancelled', 'timeout'].includes(job.status)) {
    console.log(JSON.stringify(job.result || job.error, null, 2));
    process.exitCode = job.status === 'success' ? 0 : 1;
    break;
  }
}
