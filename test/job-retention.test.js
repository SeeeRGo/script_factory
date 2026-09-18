import assert from 'node:assert/strict';
import test from 'node:test';

import { isJobExpired } from '../src/job-retention.js';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

test('marks terminal jobs older than the retention period as expired', () => {
  assert.equal(isJobExpired({
    status: 'success',
    finished_at: '2026-08-19T12:00:00.000Z'
  }, 30, NOW), true);
  assert.equal(isJobExpired({
    status: 'failed',
    finished_at: '2026-08-20T12:00:00.001Z'
  }, 30, NOW), false);
});

test('never expires queued or running jobs', () => {
  const oldTimestamp = '2020-01-01T00:00:00.000Z';
  assert.equal(isJobExpired({ status: 'queued', created_at: oldTimestamp }, 30, NOW), false);
  assert.equal(isJobExpired({ status: 'running', updated_at: oldTimestamp }, 30, NOW), false);
});

test('uses updated_at for legacy terminal jobs without finished_at', () => {
  assert.equal(isJobExpired({
    status: 'cancelled',
    updated_at: '2026-08-01T00:00:00.000Z'
  }, 30, NOW), true);
});
