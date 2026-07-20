const apiUrl = process.env.DEMO_API_URL || 'http://127.0.0.1:3000';
const apiKey = process.env.API_KEY || 'dev-secret';
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': apiKey
};

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return response.json();
}

await request('/api/v2/system/config', {
  method: 'PUT',
  body: JSON.stringify({ max_parallel_jobs: 1 })
});

const priorities = [100, 50, 10, 30];
const created = [];

for (const priority of priorities) {
  const suffix = `${Date.now()}-${priority}`;
  const payload = {
    uid: `demo-queue-P${priority}-${suffix}`,
    priority,
    timeout_ms: 10000,
    retry_policy: { max_attempts: 1, backoff_ms: 200 },
    script: {
      steps: [
        { action: 'launch_browser', delay_ms: 900 },
        { action: 'auth_ecp', delay_ms: 900 },
        { action: 'navigate', delay_ms: 900, params: { url: 'https://online.sbis.ru' } }
      ]
    }
  };
  const data = await request('/api/v2/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': payload.uid },
    body: JSON.stringify(payload)
  });
  created.push(data.job);
}

console.log('Созданы демонстрационные задания:');
for (const job of created) {
  console.log(`- P${job.priority} · ${job.uid} · ${job.job_id}`);
}
console.log('Откройте монитор очереди:', `${apiUrl}/queue`);
console.log('После активного P100 очередь должна выполняться в порядке P10 → P30 → P50.');
