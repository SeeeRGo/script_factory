const apiUrl = process.env.DEMO_API_URL || 'http://127.0.0.1:33001';
const apiKey = process.env.API_KEY || 'dev-secret';
const callbackUrl = process.env.DEMO_1C_CALLBACK_URL;
const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
const terminal = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);

async function request(pathname, options = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

await request('/api/v2/system/config', {
  method: 'PUT',
  body: JSON.stringify({ max_parallel_jobs: 3 })
});

const definitions = [
  { priority: 50, delay_ms: 15_000 },
  { priority: 10, delay_ms: 10_000 },
  { priority: 30, delay_ms: 5_000 }
];
const runId = Date.now();
const jobs = [];

for (const definition of definitions) {
  const uid = `1c-stage4-P${definition.priority}-${runId}`;
  const payload = {
    uid,
    priority: definition.priority,
    timeout_ms: 60_000,
    retry_policy: { max_attempts: 2, backoff_ms: 500 },
    context: { delay_ms: definition.delay_ms },
    ...(callbackUrl ? { callback: { url: callbackUrl, max_attempts: 5, backoff_ms: 1000, timeout_ms: 5000 } } : {}),
    script: {
      default_step_timeout_ms: 30_000,
      steps: [{
        id: 'load-window',
        title: `Ожидание P${definition.priority}`,
        description: 'Удерживает исполнительный слот без внешних действий для оценки ресурсов УН.',
        action: 'wait',
        params: { duration_ms: '{{delay_ms}}' },
        timeout_ms: 30_000
      }]
    }
  };
  const created = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': uid },
    body: JSON.stringify(payload)
  });
  jobs.push(created.job);
}

console.log(`Созданы ${jobs.length} задания. Монитор: ${apiUrl}/queue`);
let peakRunning = 0;
while (true) {
  const current = await Promise.all(jobs.map((job) => request(`/api/v2/jobs/${job.job_id}`).then((body) => body.job)));
  const resources = await request('/api/v2/system/resources');
  peakRunning = Math.max(peakRunning, resources.queue.running);
  console.log(
    `${new Date().toLocaleTimeString('ru-RU')} · CPU ${resources.cpu.system_percent}% · RAM ${resources.memory.used_percent}% · `
    + current.map((job) => `P${job.priority}:${job.status}`).join(' | ')
  );
  if (current.every((job) => terminal.has(job.status))) {
    if (!current.every((job) => job.status === 'success')) process.exitCode = 1;
    console.log(`Пиковое число параллельных заданий: ${peakRunning}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
