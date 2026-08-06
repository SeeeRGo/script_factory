import { readFile } from 'node:fs/promises';
import { runQueueCase } from './queue-case-lib.mjs';

const caseFiles = {
  'priority-error': 'queue-case-priority-error.json',
  'running-low': 'queue-case-running-low.json'
};
const caseId = process.argv[2];
if (!caseFiles[caseId]) {
  throw new Error(`Укажите queue-case: ${Object.keys(caseFiles).join(' | ')}`);
}

const apiUrl = process.env.DEMO_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const apiKey = process.env.API_KEY || 'dev-secret';
const definition = JSON.parse(await readFile(new URL(caseFiles[caseId], import.meta.url), 'utf8'));

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'X-API-Key': apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `${response.status}: ${response.statusText}`);
  return body;
}

console.log(`\n${definition.title}`);
console.log(definition.description);
console.log(`Откройте монитор: ${apiUrl}/queue\n`);

const lastLines = new Map();
const result = await runQueueCase(definition, {
  request,
  pollIntervalMs: 150,
  onUpdate({ alias, job }) {
    const line = `${alias.padEnd(5)} · P${String(job.priority).padEnd(3)} · ${job.status.padEnd(17)} · попытка ${job.attempts}/${job.max_attempts} · ${job.uid}`;
    if (lastLines.get(alias) === line) return;
    lastLines.set(alias, line);
    console.log(line);
  }
});

console.log('\nПроверки кейса:');
for (const check of result.checks) {
  console.log(`${check.passed ? '✓' : '✗'} ${check.message}`);
}
if (!result.passed) {
  process.exitCode = 1;
  console.error('\nФактическое поведение очереди не совпало с ожиданиями.');
} else {
  console.log('\nКейс подтверждён фактическими статусами и временными метками.');
}
