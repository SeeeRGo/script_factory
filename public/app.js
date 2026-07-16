const sampleJob = {
  priority: 100,
  timeout_ms: 30000,
  context: {
    root_dir: '/reports/incoming',
    loaded_dir: '/reports/loaded',
    prefixes: ['FNS', 'SFR', 'ROSSTAT']
  },
  script: {
    default_step_timeout_ms: 5000,
    steps: [
      { id: 'network', action: 'check_ip', params: { expected_ip: '10.0.0.25', current_ip: '10.0.0.25' }, duration_ms: 350 },
      { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 500 },
      { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 450 },
      { id: 'identity', action: 'auth_ecp', params: { plugin_running: true }, duration_ms: 600 },
      { id: 'reports', action: 'find_files', params: { directory: '{{root_dir}}', files: ['FNS_2026.xml', 'SFR_2026.xml'] }, duration_ms: 450 },
      { id: 'upload', action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 700 },
      { id: 'validate', action: 'validate_report', params: { valid: true }, duration_ms: 500 },
      { id: 'submit', action: 'submit_if_valid', params: {}, duration_ms: 450 },
      { id: 'archive', action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 350 }
    ]
  }
};

const terminalStatuses = new Set(['success', 'failed', 'validation_failed', 'cancelled', 'timeout']);
const elements = Object.fromEntries([
  'api-key', 'toggle-key', 'script-editor', 'line-numbers', 'format', 'preview', 'run', 'editor-state',
  'connection', 'job-status', 'progress-value', 'step-count', 'attempt-count', 'duration-value',
  'progress-bar', 'flow', 'flow-empty', 'jobs', 'logs', 'selected-job', 'refresh-jobs', 'toast'
].map((id) => [id, document.getElementById(id)]));

let selectedJobId = null;
let pollTimer = null;
let toastTimer = null;

elements['script-editor'].value = JSON.stringify(sampleJob, null, 2);
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
    throw new Error(details || data.error?.message || `Request failed (${response.status})`);
  }
  return data;
}

function parseEditor() {
  const payload = JSON.parse(elements['script-editor'].value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The editor must contain a JSON object.');
  if (!payload.script || !Array.isArray(payload.script.steps)) throw new Error('Add a script.steps array.');
  return payload;
}

function updateLineNumbers() {
  const count = elements['script-editor'].value.split('\n').length;
  elements['line-numbers'].textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function timeOnly(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeParams(params) {
  if (!params || Object.keys(params).length === 0) return 'No parameters';
  const text = Object.entries(params).slice(0, 2).map(([key, value]) => {
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `${key}: ${rendered}`;
  }).join(' · ');
  return text.length > 110 ? `${text.slice(0, 107)}…` : text;
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
  title.textContent = step.action || 'unknown';
  const detail = document.createElement('p');
  detail.textContent = step.error ? `${step.error.code}: ${step.error.message}` : describeParams(step.params);
  copy.append(title, detail);
  const duration = document.createElement('span');
  duration.className = 'step-time';
  duration.textContent = formatDuration(step.duration_ms);
  row.append(node, copy, duration);
  return row;
}

function renderExecution(job = null, previewSteps = null) {
  const execution = job?.execution;
  const steps = execution?.steps || (previewSteps || []).map((step, index) => ({
    index,
    action: step.action,
    status: 'pending',
    params: step.params || {},
    duration_ms: null
  }));
  elements.flow.replaceChildren(...steps.map(createStepRow));
  elements['flow-empty'].hidden = steps.length > 0;

  const status = job?.status || 'preview';
  elements['job-status'].textContent = status.toUpperCase();
  elements['job-status'].className = `status-pill ${status}`;
  const completed = execution?.completed_steps || 0;
  const total = execution?.total_steps ?? steps.length;
  const percent = execution?.percent || 0;
  elements['progress-value'].textContent = `${percent}%`;
  elements['step-count'].textContent = `${completed} / ${total}`;
  elements['attempt-count'].textContent = job?.attempts || '—';
  elements['duration-value'].textContent = formatDuration(execution?.duration_ms);
  elements['progress-bar'].style.width = `${percent}%`;
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
    setEditorState(`${payload.script.steps.length} valid JSON steps`);
  } catch (error) {
    setEditorState(error.message, true);
    showToast(error.message, true);
  }
}

async function run() {
  try {
    const payload = parseEditor();
    elements.run.disabled = true;
    setEditorState('Submitting…');
    const data = await api('/jobs', { method: 'POST', body: JSON.stringify(payload) });
    selectedJobId = data.job.job_id;
    renderExecution(data.job);
    setEditorState(`Started ${selectedJobId}`);
    showToast('Script accepted by the interpreter.');
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
      setEditorState(job.status === 'success' ? 'Run completed successfully' : `${job.status}: ${job.error?.message || 'Run stopped'}`, job.status !== 'success');
      await loadJobs();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderLogs(logs) {
  if (!logs?.length) {
    elements.logs.innerHTML = '<p class="muted">No events recorded yet.</p>';
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
      elements.jobs.innerHTML = '<p class="muted">No runs yet. Start one above.</p>';
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
      date.textContent = new Date(job.created_at).toLocaleString();
      const status = document.createElement('span');
      status.className = `mini-status ${job.status}`;
      status.textContent = job.status;
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
    elements.connection.className = 'connection online';
    elements.connection.lastChild.textContent = ' Online';
  } catch {
    elements.connection.className = 'connection offline';
    elements.connection.lastChild.textContent = ' Offline';
  }
}

elements['script-editor'].addEventListener('input', () => {
  updateLineNumbers();
  setEditorState('Edited · preview to validate');
});
elements['script-editor'].addEventListener('scroll', () => { elements['line-numbers'].scrollTop = elements['script-editor'].scrollTop; });
elements.format.addEventListener('click', () => {
  try {
    elements['script-editor'].value = JSON.stringify(JSON.parse(elements['script-editor'].value), null, 2);
    updateLineNumbers();
    setEditorState('JSON formatted');
  } catch (error) { showToast(error.message, true); }
});
elements.preview.addEventListener('click', preview);
elements.run.addEventListener('click', run);
elements['refresh-jobs'].addEventListener('click', loadJobs);
elements['api-key'].addEventListener('change', () => {
  localStorage.setItem('script-factory-api-key', elements['api-key'].value);
  void loadJobs();
});
elements['toggle-key'].addEventListener('click', () => {
  const hidden = elements['api-key'].type === 'password';
  elements['api-key'].type = hidden ? 'text' : 'password';
  elements['toggle-key'].textContent = hidden ? 'Hide' : 'Show';
});

void checkConnection();
void preview();
void loadJobs();
setInterval(checkConnection, 15000);
setInterval(loadJobs, 5000);
