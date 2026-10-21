import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// All pages, IP checks and callbacks in this stand stay on literal loopback.
// The XML and certificate chooser are synthetic; no tax format or signing is claimed.
const repo = path.resolve(import.meta.dirname, '..');
const work = path.join(repo, 'work');
await mkdir(work, { recursive: true });
const root = await mkdtemp(path.join(work, 'sbis-local-'));
const template = JSON.parse(await readFile(path.join(repo, 'demo/sbis-report-full.json'), 'utf8'));
const inn = '123456789012';
const scenarios = ['success', 'license', 'unknown'];
const callbacks = new Map();
const cases = new Map();
const click = selector => ({ type: 'click', selectors: [[selector]], offsetX: 10, offsetY: 10 });
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const browserCandidates = [process.env.PUPPETEER_EXECUTABLE_PATH,
  ...(process.platform === 'win32' ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).map(base => path.join(base, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe')) : ['/usr/bin/chromium'])].filter(Boolean);
let browserPath;
for (const candidate of browserCandidates) { try { await access(candidate); browserPath = candidate; break; } catch { /* try installed candidate */ } }
if (!browserPath) throw new Error('Stand browser not found; set PUPPETEER_EXECUTABLE_PATH for this command.');
let child;
let childLog = '';
const stand = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ip') { res.setHeader('Content-Type', 'application/json'); res.end('{"ip":"198.51.100.7"}'); return; }
    if (url.pathname === '/callback' && req.method === 'POST') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('Callback is too large'); chunks.push(chunk); }
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      callbacks.set(event.job.job_id, event);
      await writeFile(path.join(root, `callback-${event.job.job_id}.json`), JSON.stringify(event, null, 2));
      res.setHeader('Content-Type', 'application/json'); res.end('{"accepted":true,"simulation":true}'); return;
    }
    const [, scenario, route] = url.pathname.split('/');
    const state = cases.get(scenario);
    if (!state) { res.writeHead(404); res.end(); return; }
    if (route === 'imported') { state.imported++; res.end('ok'); return; }
    if (route === 'checked') { state.checked++; res.end('ok'); return; }
    if (route === 'submitted') { state.submitted++; res.end('SIMULATED ONLY'); return; }
    if (route === 'attempted') { state.attempted++; res.end('BLOCKED'); return; }
    const prefix = `/${scenario}`;
    const name = url.searchParams.get('name');
    const rows = state.names.map(file => `<div class="FileBrowserComponent__Browser__columnName"><i style="display:inline-block;width:12px;height:12px" data-minicard-name="${file}" data-minicard-path="${escapeHtml(path.join(state.incoming, file))}"></i><div class="FileBrowserComponent__Browser__columnNameRow" ondblclick="document.querySelector('#picker').hidden=true;document.querySelector('#card').hidden=false;document.querySelector('#card').dataset.reportKey='key-${file}';fetch('${prefix}/imported')">${file}</div></div>`).join('');
    const submit = scenario === 'license' ? `document.querySelector('#license').hidden=false;fetch('${prefix}/attempted')` : `fetch('${prefix}/submitted').then(()=>document.querySelector('#sent').textContent='${scenario === 'unknown' ? 'Отправляется' : 'Отправлено'}')`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>Отчеты</title></head><body>
      <p><strong>УЧЕБНЫЙ ЛОКАЛЬНЫЙ СТЕНД. Подпись, проверка и отправка имитируются.</strong></p>
      <button onclick="document.querySelector('#chooser').hidden=false">По ключу подписи</button>
      <div id="chooser" hidden><div class="expired"><div class="cert">Истекшая учебная ЭЦП ${inn}</div></div><div class="cert" onclick="location.href='${prefix}/cabinet'">Учебная ЭЦП ${inn}</div></div>
      <div id="org">${inn}</div>
      <button title="Загрузить" onclick="document.querySelector('#picker').hidden=false">Загрузить</button>
      <div id="picker" hidden><button>С компьютера</button><button>Загрузки</button>${rows}</div>
      <div id="card" class="report-theme__contrastWrapper" ${name ? '' : 'hidden'} data-report-key="${name ? escapeHtml('key-' + name) : 'before'}">
        ${inn}<div class="np-StickerTab__main">Отчет создан</div>
        <button title="Проверить" onclick="fetch('${prefix}/checked');document.querySelector('#validation-panel').hidden=false;document.querySelector('#validation').textContent='Выполняется проверка';setTimeout(()=>document.querySelector('#validation').textContent='Ошибки не найдены',200)">Проверить</button>
        <button id="send" onclick="${submit}">Имитировать отправку</button><div id="sent"></div>
      </div>
      <aside id="license" hidden>Но нет лицензии &quot;Отчетность&quot;</aside>
      <div id="validation-panel" hidden><span id="validation"></span><div id="protocol">УЧЕБНЫЙ СТЕНД: результат проверки имитируется, это не протокол ведомства.</div></div>
    </body></html>`);
  } catch { res.writeHead(500); res.end('Stand error'); }
});
await new Promise(resolve => stand.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${stand.address().port}`;
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const apiPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const api = `http://127.0.0.1:${apiPort}`;
const apiKey = randomUUID();
const settings = path.join(root, 'stand-settings.ini');
await writeFile(settings, '[main]\nip_adress=198.51.100.7\n');
const request = async (pathname, options = {}) => {
  const response = await fetch(api + pathname, { ...options, signal: AbortSignal.timeout(15000), headers: { 'X-API-Key': apiKey, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  assert.ok(response.ok, `API ${response.status}: ${await response.clone().text()}`);
  return response;
};
const until = async (fn, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Stand timed out');
};
try {
  child = spawn(process.execPath, ['src/server.js'], { cwd: repo, env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), API_KEY: apiKey,
    UN_ID: 'un-local-stand', WEB_LOGIN: 'stand', WEB_PASSWORD: randomUUID(),
    DATA_DIR: path.join(root, 'api-data'), FILESYSTEM_ALLOWED_ROOTS: root,
    MAX_PARALLEL_JOBS: '1', CALLBACK_AUTH_TOKEN: '', CALLBACK_AUTH_USERNAME: '', CALLBACK_AUTH_PASSWORD: '',
    CALLBACK_ALLOWED_ORIGINS: origin, IP_CHECK_URL: origin + '/ip', IP_MONITOR_SETTINGS_PATH: settings,
    SERVICE_BASE_URL: api, NOVNC_ENABLED: 'false', BROWSER_HEADLESS: process.argv.includes('--headed') ? 'false' : 'true',
    PUPPETEER_EXECUTABLE_PATH: browserPath
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { childLog += chunk; }); child.stderr.on('data', chunk => { childLog += chunk; });
  let readiness;
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error('Isolated API exited');
      let response;
      try { response = await fetch(api + '/health', { signal: AbortSignal.timeout(10000) }); } catch { return false; }
      readiness = await response.json();
      if (!response.ok) throw new Error('Isolated API is not ready: ' + JSON.stringify({ checks: readiness.checks, error: readiness.error }));
      return true;
    }, 45000);
  } catch (error) { throw new Error('Isolated API startup failed: ' + error.message, { cause: error }); }
  const proof = { simulation: true, official_submission: false, api_version: (await (await request('/health')).json()).version, scenarios: [] };
  for (const scenario of scenarios) {
    const incoming = path.join(root, scenario, 'incoming'), loaded = path.join(root, scenario, 'loaded');
    await mkdir(incoming, { recursive: true }); await mkdir(loaded, { recursive: true });
    const names = ['FNS_TEST_ONLY.xml', 'SFR_TEST_ONLY.xml', 'STAT_TEST_ONLY.xml'];
    for (const name of names) await writeFile(path.join(incoming, name), '<TestOnly simulation="true">NOT A TAX REPORT</TestOnly>');
    const state = { names, incoming, imported: 0, checked: 0, submitted: 0, attempted: 0 }; cases.set(scenario, state);
    const ui = { ...template.context.ui, certificate_rows_selector: '#chooser .cert', certificate_unusable_selector: '.expired',
      organization_steps: [{ type: 'navigate', url: `${origin}/${scenario}/organization` }], organization_selector: '#org', authority_steps: [],
      authority_paths: { FNS: '/fns', SFR: '/sfr', ROSSTAT: '/stat' }, report_scope_selector: '#card', current_card_scope_selector: '#card',
      report_identity_steps: [], report_key_expression: "document.querySelector('#card').dataset.reportKey",
      validation_scope_selector: '#validation-panel', validation_status_selector: '#validation', protocol_selector: '#protocol',
      validation_success_text: 'Ошибки не найдены', validation_failure_text: 'Найденные ошибки',
      reopen_steps: [{ type: 'navigate', url: `${origin}/${scenario}/reopen?name={{file_name}}` }], submit_steps: [click('#send')],
      sent_status_selector: '#sent', sent_status_text: 'Отправлено', sent_scope_selector: '#card' };
    const created = await (await request('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ parameters: {
      uid: 'LOCAL-STAND-' + scenario + '-' + randomUUID(), timeout_ms: 180000, retry_policy: { max_attempts: 1 },
      callback: { url: origin + '/callback' }, context: { mode: 'send', submit_enabled: true, inn, certificate_inn: inn, certificate_selection_required: true,
        login_url: `${origin}/${scenario}/login`, report_url: `${origin}/${scenario}/report`, authenticated_url: `${origin}/${scenario}/cabinet`,
        root_dir: incoming, loaded_dir: loaded, error_dir: loaded, ui, upload_directory_steps: [{ type: 'waitForExpression', expression: 'true' }],
        validation_timeout_ms: 10000, submit_timeout_ms: 1000,
        authority_prefixes: [{ authority: 'FNS', prefixes: ['FNS_'] }, { authority: 'SFR', prefixes: ['SFR_'] }, { authority: 'ROSSTAT', prefixes: ['STAT_'] }] }
    }, script_text: JSON.stringify(template) }) })).json();
    const id = created.job.job_id;
    const job = await until(async () => { const j = (await (await request('/api/v2/jobs/' + id)).json()).job; return ['queued', 'running'].includes(j.status) ? false : j; });
    const expected = scenario === 'success' ? 'sent' : scenario === 'license' ? 'license_required' : 'requires_reconciliation';
    assert.equal(job.result.Rezult_1.state, expected);
    assert.equal(job.status, scenario === 'success' ? 'success' : 'failed');
    if (scenario === 'license') assert.equal(job.error.code, 'REPORTING_LICENSE_REQUIRED');
    assert.equal(state.submitted, scenario === 'success' ? 3 : scenario === 'unknown' ? 1 : 0);
    assert.equal((await readdir(loaded)).length, scenario === 'success' ? 6 : 0);
    const artifact = job.result.artifacts.filter(a => /^result-\d+\.json$/.test(a.filename)).at(-1);
    assert.ok(artifact);
    const downloaded = await (await request(artifact.api_url)).json(); assert.deepEqual(downloaded, Object.fromEntries(Object.entries(job.result).filter(([key])=>/^Rezult_[1-9]\d*$/.test(key))));
    const callback = await until(async () => callbacks.get(id)); assert.deepEqual(Object.fromEntries(Object.entries(callback.job.result).filter(([key])=>/^Rezult_[1-9]\d*$/.test(key))), downloaded);
    assert.equal(Object.keys(downloaded).length,3);
    for(const record of Object.values(downloaded))for(const value of Object.values(record))assert.ok(value===null||['string','number','boolean'].includes(typeof value));
    assert.equal(callback.job.status, job.status); assert.equal(callback.job.error?.code, job.error?.code);
    proof.scenarios.push({ scenario, job_id: id, status: job.status, state: expected, error_code: job.error?.code || null, imported: state.imported,
      checked: state.checked, simulated_submissions: state.submitted, blocked_attempts: state.attempted, archived_files: (await readdir(loaded)).length,
      artifact_filename: artifact.filename, artifact_matches_result: true, callback_matches_result: true });
  }
  await writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ simulation: true, official_submission: false, scenarios_passed: proof.scenarios.length, proof_file: path.join(root, 'proof.json') }));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await writeFile(path.join(root, 'stand-api.log'), childLog);
  await new Promise(resolve => stand.close(resolve));
}
