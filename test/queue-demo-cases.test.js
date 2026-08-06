import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validateQueueCase } from '../demo/queue-case-lib.mjs';
import { validateScript } from '../src/interpreter.js';

const caseFiles = [
  'queue-case-priority-error.json',
  'queue-case-running-low.json'
];

test('queue demo cases are declarative, valid and contain several jobs', async () => {
  for (const filename of caseFiles) {
    const definition = JSON.parse(await readFile(path.resolve(import.meta.dirname, `../demo/${filename}`), 'utf8'));
    assert.deepEqual(validateQueueCase(definition), [], filename);
    assert.equal(definition.config.max_parallel_jobs, 1);
    assert.ok(definition.jobs.length >= 2);
    assert.ok(definition.expectations.length >= 4);

    for (const item of definition.jobs) {
      assert.deepEqual(validateScript(item.payload.script), [], `${filename}:${item.alias}`);
      assert.ok(item.payload.script.steps.length >= 6, `${filename}:${item.alias} должен выглядеть наглядно`);
      assert.ok(item.payload.script.steps.every((step) => step.title && step.description));
      assert.ok(item.payload.retry_policy.max_attempts >= 1);
    }
    assert.ok(definition.jobs.some((item) => item.payload.retry_policy.max_attempts >= 2), `${filename} должен показывать retry`);
  }
});

test('case 1 has two observed priorities and a controlled high-priority failure', async () => {
  const definition = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, '../demo/queue-case-priority-error.json'),
    'utf8'
  ));
  const observed = definition.jobs.filter((item) => item.role === 'observed');
  assert.deepEqual(observed.map((item) => item.payload.priority).sort((a, b) => a - b), [10, 50]);
  assert.ok(definition.expectations.some((item) => item.type === 'simultaneously_queued'));
  assert.ok(definition.expectations.some((item) => item.job === 'high' && item.type === 'attempts' && item.count === 2));
  assert.ok(definition.expectations.some((item) => item.job === 'high' && item.error_code === 'PLUGIN_NOT_RUNNING'));
});

test('case 2 submits P10 during the second P50 attempt and checks non-preemption', async () => {
  const definition = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, '../demo/queue-case-running-low.json'),
    'utf8'
  ));
  const high = definition.jobs.find((item) => item.alias === 'high');
  assert.deepEqual(high.submit, { type: 'after_attempt', job: 'low', attempt: 2, status: 'running', delay_ms: 800 });
  assert.ok(definition.expectations.some((item) => item.type === 'starts_after_finished'));
  assert.ok(definition.expectations.some((item) => item.job === 'low' && item.type === 'attempts' && item.count === 2));
  assert.ok(definition.expectations.some((item) => item.job === 'low' && item.error_code === 'PLUGIN_NOT_RUNNING'));
});
