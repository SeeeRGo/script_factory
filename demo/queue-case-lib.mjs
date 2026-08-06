const TERMINAL_STATUSES = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function validateQueueCase(definition) {
  const errors = [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return ['Корень queue-case должен быть JSON-объектом'];
  }
  if (definition.schema_version !== 1) errors.push('schema_version должен быть равен 1');
  if (typeof definition.id !== 'string' || !definition.id) errors.push('id обязателен');
  if (!Number.isInteger(definition.config?.max_parallel_jobs) || definition.config.max_parallel_jobs < 1) {
    errors.push('config.max_parallel_jobs должен быть положительным целым числом');
  }
  if (!Array.isArray(definition.jobs) || definition.jobs.length < 2) {
    errors.push('jobs должен содержать минимум два задания');
    return errors;
  }
  const aliases = new Set();
  for (const [index, item] of definition.jobs.entries()) {
    const prefix = `jobs[${index}]`;
    if (typeof item.alias !== 'string' || !item.alias) errors.push(`${prefix}.alias обязателен`);
    else if (aliases.has(item.alias)) errors.push(`${prefix}.alias должен быть уникальным`);
    else aliases.add(item.alias);
    if (!['immediate', 'after_status'].includes(item.submit?.type)) errors.push(`${prefix}.submit.type не поддерживается`);
    if (!item.payload?.script || !Array.isArray(item.payload.script.steps)) errors.push(`${prefix}.payload.script.steps обязателен`);
    if (!Number.isFinite(item.payload?.priority)) errors.push(`${prefix}.payload.priority обязателен`);
  }
  for (const [index, item] of definition.jobs.entries()) {
    if (item.submit?.type === 'after_status' && !aliases.has(item.submit.job)) {
      errors.push(`jobs[${index}].submit.job ссылается на неизвестный alias`);
    }
  }
  if (!Array.isArray(definition.expectations) || definition.expectations.length === 0) {
    errors.push('expectations должен содержать минимум одну проверку');
  }
  return errors;
}

async function readJob(request, job) {
  return (await request(`/api/v2/jobs/${encodeURIComponent(job.job_id)}`)).job;
}

async function waitForStatus(request, job, expectedStatus, deadline, pollIntervalMs, observe) {
  while (Date.now() < deadline) {
    const current = await readJob(request, job);
    await observe();
    if (current.status === expectedStatus) return current;
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new Error(`${current.uid} завершилось со статусом ${current.status} до ожидаемого ${expectedStatus}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Не дождались статуса ${expectedStatus} для ${job.uid}`);
}

function evaluateExpectation(expectation, jobsByAlias, observations) {
  const job = (alias) => jobsByAlias.get(alias);
  switch (expectation.type) {
    case 'simultaneously_queued': {
      const passed = observations.some((snapshot) => expectation.jobs.every((alias) => snapshot[alias] === 'queued'));
      return { passed, message: `${expectation.jobs.join(' и ')} одновременно находились в queued` };
    }
    case 'starts_before': {
      const first = asTimestamp(job(expectation.first)?.started_at);
      const second = asTimestamp(job(expectation.second)?.started_at);
      return { passed: first !== null && second !== null && first < second, message: `${expectation.first} запустилось раньше ${expectation.second}` };
    }
    case 'created_while_running': {
      const created = asTimestamp(job(expectation.created)?.created_at);
      const started = asTimestamp(job(expectation.running)?.started_at);
      const finished = asTimestamp(job(expectation.running)?.finished_at);
      return {
        passed: created !== null && started !== null && finished !== null && created >= started && created <= finished,
        message: `${expectation.created} создано во время выполнения ${expectation.running}`
      };
    }
    case 'starts_after_finished': {
      const started = asTimestamp(job(expectation.job)?.started_at);
      const finished = asTimestamp(job(expectation.after)?.finished_at);
      return {
        passed: started !== null && finished !== null && started >= finished,
        message: `${expectation.job} запустилось только после завершения ${expectation.after}`
      };
    }
    case 'terminal': {
      const current = job(expectation.job);
      const statusMatches = current?.status === expectation.status;
      const errorMatches = !expectation.error_code || current?.error?.code === expectation.error_code;
      return {
        passed: statusMatches && errorMatches,
        message: `${expectation.job} завершилось как ${expectation.status}${expectation.error_code ? ` / ${expectation.error_code}` : ''}`
      };
    }
    default:
      return { passed: false, message: `Неизвестная проверка ${expectation.type}` };
  }
}

export async function runQueueCase(definition, options) {
  const errors = validateQueueCase(definition);
  if (errors.length > 0) throw new Error(`Некорректный queue-case: ${errors.join('; ')}`);

  const {
    request,
    pollIntervalMs = 100,
    runId = Date.now().toString(36),
    onUpdate = () => {}
  } = options;
  const deadline = Date.now() + (definition.timeout_ms || 20_000);
  const jobsByAlias = new Map();
  const observations = [];
  const lastStatuses = new Map();

  const observe = async () => {
    const snapshot = {};
    for (const [alias, knownJob] of jobsByAlias) {
      const current = await readJob(request, knownJob);
      jobsByAlias.set(alias, current);
      snapshot[alias] = current.status;
      if (lastStatuses.get(alias) !== current.status) {
        lastStatuses.set(alias, current.status);
        onUpdate({ alias, job: current });
      }
    }
    observations.push(snapshot);
    return snapshot;
  };

  const resources = await request('/api/v2/system/resources');
  if (resources.queue.running > 0 || resources.queue.queued > 0) {
    throw new Error('Для воспроизводимого показа очередь должна быть пустой перед запуском кейса');
  }
  const originalConfig = (await request('/api/v2/system/config')).config;
  await request('/api/v2/system/config', {
    method: 'PUT',
    body: JSON.stringify({ max_parallel_jobs: definition.config.max_parallel_jobs })
  });

  try {
    for (const item of definition.jobs) {
      if (item.submit.type === 'after_status') {
        const dependency = jobsByAlias.get(item.submit.job);
        if (!dependency) throw new Error(`Задание ${item.alias} ожидает ещё не созданное ${item.submit.job}`);
        await waitForStatus(request, dependency, item.submit.status, deadline, pollIntervalMs, observe);
        if (item.submit.delay_ms > 0) await sleep(item.submit.delay_ms);
      }
      const payload = structuredClone(item.payload);
      payload.uid = `${payload.uid}-${runId}`;
      const created = await request('/api/v2/jobs', {
        method: 'POST',
        headers: { 'Idempotency-Key': payload.uid },
        body: JSON.stringify(payload)
      });
      jobsByAlias.set(item.alias, created.job);
      onUpdate({ alias: item.alias, job: created.job, created: true });
      await observe();
    }

    while (Date.now() < deadline) {
      await observe();
      if ([...jobsByAlias.values()].every((job) => TERMINAL_STATUSES.has(job.status))) break;
      await sleep(pollIntervalMs);
    }
    await observe();
    if (![...jobsByAlias.values()].every((job) => TERMINAL_STATUSES.has(job.status))) {
      throw new Error(`Queue-case ${definition.id} не завершился за отведённое время`);
    }

    const checks = definition.expectations.map((expectation) => ({
      expectation,
      ...evaluateExpectation(expectation, jobsByAlias, observations)
    }));
    return {
      id: definition.id,
      title: definition.title,
      passed: checks.every((check) => check.passed),
      jobs: Object.fromEntries(jobsByAlias),
      observations,
      checks
    };
  } finally {
    await request('/api/v2/system/config', {
      method: 'PUT',
      body: JSON.stringify({ max_parallel_jobs: originalConfig.max_parallel_jobs })
    }).catch(() => {});
  }
}
