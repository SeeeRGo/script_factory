import { blankScenario, demoScenarios } from './scenarios.js';

const terminalStatuses = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);
const statusLabels = {
  preview: 'ПРЕДПРОСМОТР',
  queued: 'В ОЧЕРЕДИ',
  running: 'ВЫПОЛНЯЕТСЯ',
  retrying: 'ПОВТОР',
  success: 'УСПЕШНО',
  failed: 'ОШИБКА',
  validation_failed: 'ОШИБКА ПРОВЕРКИ',
  cancelled: 'ОТМЕНЕНО',
  timeout: 'ТАЙМ-АУТ'
};
const elements = Object.fromEntries([
  'api-key', 'toggle-key', 'script-editor', 'line-numbers', 'format', 'preview', 'run', 'editor-state',
  'connection', 'job-status', 'progress-value', 'step-count', 'attempt-count', 'duration-value',
  'progress-bar', 'flow', 'flow-empty', 'jobs', 'logs', 'selected-job', 'refresh-jobs', 'toast',
  'scenario-list', 'scenario-current', 'new-script', 'artifacts', 'artifact-section', 'browser-live-link',
  'browser-live-section', 'browser-live-frame', 'browser-live-open', 'browser-live-status'
].map((id) => [id, document.getElementById(id)]));

let selectedJobId = null;
let activeScenarioId = demoScenarios[0].id;
let pollTimer = null;
let toastTimer = null;

elements['script-editor'].value = JSON.stringify(demoScenarios[0].payload, null, 2);
elements['api-key'].value = localStorage.getItem('script-factory-api-key') || 'dev-secret';
updateLineNumbers();

function apiHeaders(json = false) {
  return {
    'X-API-Key': elements['api-key'].value,
    ...(json ? { 'Content-Type': 'application/json' } : {})
  };
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v2${path}`, {
    ...options,
    headers: { ...apiHeaders(Boolean(options.body)), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data.error?.details?.errors?.map((item) => `${item.path}: ${item.message}`).join('; ');
    throw new Error(details || data.error?.message || `Ошибка запроса (${response.status})`);
  }
  return data;
}

function parseEditor() {
  const payload = JSON.parse(elements['script-editor'].value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Редактор должен содержать JSON-объект.');
  if (!payload.script || !Array.isArray(payload.script.steps)) throw new Error('Добавьте массив script.steps.');
  return payload;
}

function updateLineNumbers() {
  const count = elements['script-editor'].value.split('\n').length;
  elements['line-numbers'].textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
}

function renderScenarioLibrary() {
  elements['scenario-list'].replaceChildren(...demoScenarios.map((scenario) => {
    const article = document.createElement('article');
    article.className = `scenario-card ${scenario.tone}${scenario.id === activeScenarioId ? ' selected' : ''}`;
    article.dataset.scenarioId = scenario.id;

    const top = document.createElement('div');
    top.className = 'scenario-card-top';
    top.innerHTML = `<span class="scenario-number">${scenario.number}</span><span class="scenario-time">${scenario.talkTime}</span>`;

    const title = document.createElement('h3');
    title.textContent = scenario.title;
    const summary = document.createElement('p');
    summary.className = 'scenario-summary';
    summary.textContent = scenario.summary;

    const points = document.createElement('ul');
    points.className = 'scenario-points';
    points.replaceChildren(...scenario.points.map((point) => {
      const item = document.createElement('li');
      item.textContent = point;
      return item;
    }));

    const meta = document.createElement('div');
    meta.className = 'scenario-meta';
    const result = document.createElement('span');
    result.className = `scenario-result ${scenario.tone}`;
    result.textContent = scenario.result;
    const runtime = document.createElement('span');
    runtime.textContent = scenario.runtime;
    meta.append(result, runtime);

    const actions = document.createElement('div');
    actions.className = 'scenario-actions';
    actions.innerHTML = `
      <button class="scenario-open" type="button" data-action="open">В редактор</button>
      <button class="scenario-run" type="button" data-action="run">Запустить <span>→</span></button>
    `;

    article.append(top, title, summary, points, meta, actions);
    return article;
  }));
}

function setEditorPayload(payload, label, scenarioId = null) {
  activeScenarioId = scenarioId;
  elements['script-editor'].value = JSON.stringify(payload, null, 2);
  elements['scenario-current'].textContent = label;
  updateLineNumbers();
  renderScenarioLibrary();
  void preview();
}

function loadScenario(scenarioId, scroll = true) {
  const scenario = demoScenarios.find((item) => item.id === scenarioId);
  if (!scenario) return;
  setEditorPayload(scenario.payload, `Демо · ${scenario.title}`, scenario.id);
  if (scroll) document.querySelector('.studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`«${scenario.title}» загружен в редактор.`);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(2)} с`;
}

function timeOnly(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeParams(params) {
  if (!params || Object.keys(params).length === 0) return 'Нет параметров';
  const text = Object.entries(params).slice(0, 2).map(([key, value]) => {
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `${key}: ${rendered}`;
  }).join(' · ');
  return text.length > 110 ? `${text.slice(0, 107)}…` : text;
}

function describeOutput(output) {
  if (!output || Object.keys(output).length === 0) return 'Шаг завершён';
  if (Array.isArray(output.artifacts) && output.artifacts.length > 0) {
    return `Скачано: ${output.artifacts.map((artifact) => artifact.filename).join(', ')}`;
  }
  return `Результат · ${describeParams(output)}`;
}

function createStepRow(step, index) {
  const row = document.createElement('div');
  row.className = `flow-step ${step.status || 'pending'}`;
  const node = document.createElement('span');
  node.className = 'step-node';
  node.textContent = step.status === 'success' ? '✓' : step.status === 'failed' ? '!' : String(index + 1).padStart(2, '0');
  const copy = document.createElement('div');
  copy.className = 'step-copy';
  const title = document.createElement('strong');
  title.textContent = step.action || 'неизвестно';
  const detail = document.createElement('p');
  detail.textContent = step.error
    ? `${step.error.code}: ${step.error.message}`
    : step.status === 'success'
      ? describeOutput(step.output)
      : describeParams(step.params);
  copy.append(title, detail);
  const duration = document.createElement('span');
  duration.className = 'step-time';
  duration.textContent = formatDuration(step.duration_ms);
  row.append(node, copy, duration);
  return row;
}

function previewStepParams(step) {
  if (step.params) return step.params;
  if (!step.type) return {};
  const { type, id, ...params } = step;
  return params;
}

function renderExecution(job = null, previewSteps = null) {
  const execution = job?.execution;
  const steps = execution?.steps || (previewSteps || []).map((step, index) => ({
    index,
    action: step.action || step.type,
    status: 'pending',
    params: previewStepParams(step),
    duration_ms: null
  }));
  elements.flow.replaceChildren(...steps.map(createStepRow));
  elements['flow-empty'].hidden = steps.length > 0;

  const status = job?.status || 'preview';
  elements['job-status'].textContent = statusLabels[status] || status.toUpperCase();
  elements['job-status'].className = `status-pill ${status}`;
  const completed = execution?.completed_steps || 0;
  const total = execution?.total_steps ?? steps.length;
  const percent = execution?.percent || 0;
  elements['progress-value'].textContent = `${percent}%`;
  elements['step-count'].textContent = `${completed} / ${total}`;
  elements['attempt-count'].textContent = job?.attempts || '—';
  elements['duration-value'].textContent = formatDuration(execution?.duration_ms);
  elements['progress-bar'].style.width = `${percent}%`;
  renderArtifacts(job);
}

function renderArtifacts(job) {
  const artifacts = job?.result?.artifacts || [];
  elements['artifact-section'].hidden = artifacts.length === 0;
  if (artifacts.length === 0) {
    elements.artifacts.replaceChildren();
    return;
  }
  elements.artifacts.replaceChildren(...artifacts.map((artifact) => {
    const link = document.createElement('a');
    link.className = 'artifact-card';
    link.href = artifact.public_url || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    if (artifact.kind === 'browser_screenshot' && artifact.public_url) {
      const image = document.createElement('img');
      image.src = artifact.public_url;
      image.alt = `Скриншот результата ${artifact.filename}`;
      link.append(image);
    }
    const caption = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = artifact.filename;
    const kind = document.createElement('small');
    kind.textContent = artifact.kind;
    caption.append(name, kind);
    link.append(caption);
    return link;
  }));
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 3500);
}

function setEditorState(message, error = false) {
  elements['editor-state'].textContent = message;
  elements['editor-state'].className = `editor-state${error ? ' error' : ''}`;
}

async function preview() {
  try {
    const payload = parseEditor();
    renderExecution(null, payload.script.steps);
    const runtime = payload.script.steps.some((step) => step.type) ? 'Puppeteer Replay' : 'JSON Steps';
    setEditorState(`${runtime} · шагов: ${payload.script.steps.length}`);
  } catch (error) {
    setEditorState(error.message, true);
    showToast(error.message, true);
  }
}

async function run() {
  if (elements.run.disabled) return;
  try {
    const payload = parseEditor();
    elements.run.disabled = true;
    setEditorState('Отправка…');
    const data = await api('/jobs', { method: 'POST', body: JSON.stringify(payload) });
    selectedJobId = data.job.job_id;
    renderExecution(data.job);
    setEditorState(`Запущено ${selectedJobId}`);
    showToast('Сценарий принят интерпретатором.');
    await loadJobs();
    await pollSelectedJob();
  } catch (error) {
    setEditorState(error.message, true);
    showToast(error.message, true);
  } finally {
    elements.run.disabled = false;
  }
}

async function pollSelectedJob() {
  clearTimeout(pollTimer);
  if (!selectedJobId) return;
  try {
    const [{ job }, logData] = await Promise.all([
      api(`/jobs/${encodeURIComponent(selectedJobId)}`),
      api(`/jobs/${encodeURIComponent(selectedJobId)}/logs`)
    ]);
    renderExecution(job);
    renderLogs(logData.logs);
    elements['selected-job'].textContent = job.job_id;
    highlightSelectedJob();
    if (!terminalStatuses.has(job.status)) {
      pollTimer = setTimeout(pollSelectedJob, 650);
    } else {
      setEditorState(job.status === 'success' ? 'Запуск успешно завершён' : `${statusLabels[job.status] || job.status}: ${job.error?.message || 'Запуск остановлен'}`, job.status !== 'success');
      await loadJobs();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderLogs(logs) {
  if (!logs?.length) {
    elements.logs.innerHTML = '<p class="muted">Событий пока нет.</p>';
    return;
  }
  elements.logs.replaceChildren(...logs.map((log) => {
    const row = document.createElement('div');
    row.className = `log-row ${log.level}`;
    const time = document.createElement('time');
    time.textContent = timeOnly(log.ts);
    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = log.level;
    const message = document.createElement('span');
    message.textContent = log.message;
    if (log.details) {
      const details = document.createElement('small');
      details.className = 'log-details';
      details.textContent = JSON.stringify(log.details);
      message.append(details);
    }
    row.append(time, level, message);
    return row;
  }));
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

async function loadJobs() {
  try {
    const data = await api('/jobs?limit=20');
    if (!data.items.length) {
      elements.jobs.innerHTML = '<p class="muted">Запусков пока нет. Создайте первый выше.</p>';
      return;
    }
    elements.jobs.replaceChildren(...data.items.map((job) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `job-row${job.job_id === selectedJobId ? ' selected' : ''}`;
      button.dataset.jobId = job.job_id;
      const id = document.createElement('strong');
      id.textContent = job.uid;
      const date = document.createElement('time');
      date.textContent = new Date(job.created_at).toLocaleString('ru-RU');
      const status = document.createElement('span');
      status.className = `mini-status ${job.status}`;
      status.textContent = statusLabels[job.status] || job.status;
      button.append(id, status, date);
      button.addEventListener('click', () => {
        selectedJobId = job.job_id;
        void pollSelectedJob();
      });
      return button;
    }));
  } catch (error) {
    elements.jobs.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

function highlightSelectedJob() {
  document.querySelectorAll('.job-row').forEach((row) => row.classList.toggle('selected', row.dataset.jobId === selectedJobId));
}

async function checkConnection() {
  try {
    const response = await fetch('/health');
    if (!response.ok) throw new Error();
    const health = await response.json();
    elements.connection.className = 'connection online';
    elements.connection.lastChild.textContent = ` Подключено · ${health.un_id}`;
    const liveView = health.browser_replay?.live_view;
    if (liveView?.enabled) {
      const liveUrl = liveView.embedded_url || liveView.public_url
        || `${location.protocol}//${location.hostname}:${liveView.port}${liveView.path}`;
      elements['browser-live-link'].href = liveUrl;
      elements['browser-live-link'].hidden = false;
      elements['browser-live-link'].title = `Живой экран · пауза между шагами ${health.browser_replay.step_delay_ms || 0} мс`;
      elements['browser-live-open'].href = liveUrl;
      elements['browser-live-section'].hidden = false;
      elements['browser-live-status'].className = 'browser-live-status online';
      elements['browser-live-status'].lastChild.textContent = ` Доступен · :${liveView.port}`;
      if (elements['browser-live-frame'].dataset.url !== liveUrl) {
        elements['browser-live-frame'].src = liveUrl;
        elements['browser-live-frame'].dataset.url = liveUrl;
      }
    } else {
      elements['browser-live-link'].hidden = true;
      elements['browser-live-section'].hidden = true;
    }
  } catch {
    elements.connection.className = 'connection offline';
    elements.connection.lastChild.textContent = ' Нет подключения';
    elements['browser-live-link'].hidden = true;
    elements['browser-live-section'].hidden = true;
  }
}

elements['script-editor'].addEventListener('input', () => {
  activeScenarioId = null;
  elements['scenario-current'].textContent = 'Пользовательский сценарий';
  document.querySelectorAll('.scenario-card').forEach((card) => card.classList.remove('selected'));
  updateLineNumbers();
  setEditorState('Изменено · откройте предпросмотр для проверки');
});
elements['script-editor'].addEventListener('scroll', () => { elements['line-numbers'].scrollTop = elements['script-editor'].scrollTop; });
elements.format.addEventListener('click', () => {
  try {
    elements['script-editor'].value = JSON.stringify(JSON.parse(elements['script-editor'].value), null, 2);
    updateLineNumbers();
    setEditorState('JSON отформатирован');
  } catch (error) { showToast(error.message, true); }
});
elements.preview.addEventListener('click', preview);
elements.run.addEventListener('click', run);
elements['scenario-list'].addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const card = button?.closest('[data-scenario-id]');
  if (!button || !card) return;
  loadScenario(card.dataset.scenarioId);
  if (button.dataset.action === 'run') void run();
});
elements['new-script'].addEventListener('click', () => {
  setEditorPayload(blankScenario, 'Новый сценарий');
  elements['script-editor'].focus();
  showToast('Чистый шаблон готов к редактированию.');
});
elements['refresh-jobs'].addEventListener('click', loadJobs);
elements['api-key'].addEventListener('change', () => {
  localStorage.setItem('script-factory-api-key', elements['api-key'].value);
  void loadJobs();
});
elements['toggle-key'].addEventListener('click', () => {
  const hidden = elements['api-key'].type === 'password';
  elements['api-key'].type = hidden ? 'text' : 'password';
  elements['toggle-key'].textContent = hidden ? 'Скрыть' : 'Показать';
});

renderScenarioLibrary();
void checkConnection();
void preview();
void loadJobs();
setInterval(checkConnection, 15000);
setInterval(loadJobs, 5000);
