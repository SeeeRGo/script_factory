const TERMINAL_JOB_STATUSES = new Set([
  'success',
  'failed',
  'validation_failed',
  'cancelled',
  'timeout'
]);

export function isJobExpired(job, retentionDays, now = Date.now()) {
  if (!TERMINAL_JOB_STATUSES.has(job?.status)) return false;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) return false;

  const referenceTime = Date.parse(job.finished_at || job.updated_at || job.created_at || '');
  if (!Number.isFinite(referenceTime)) return false;

  return referenceTime <= now - retentionDays * 24 * 60 * 60 * 1000;
}
