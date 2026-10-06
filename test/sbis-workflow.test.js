import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeSbisWorkflow, findLatestReports, archiveReport, sbisAuthorityPlans } from '../src/sbis-workflow.js';
import { validateScript } from '../src/interpreter.js';

const template = JSON.parse(await readFile(new URL('../demo/sbis-report-full.json', import.meta.url), 'utf8'));
const click = (selector) => ({ type: 'click', selectors: [[selector]], offsetX: 5, offsetY: 5 });
async function files(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sbis-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const incoming = path.join(root, 'incoming'); const loaded = path.join(root, 'loaded');
  await mkdir(incoming); await mkdir(loaded);
  return { root, incoming, loaded };
}

test('SBIS schema requires all real stages in order', () => {
  assert.deepEqual(validateScript(template), []);
  assert.ok(validateScript({ ...template, steps: template.steps.slice(1) }).length);
  assert.ok(validateScript({ ...template, steps: template.steps.map((s, i) => i === 5 ? { action: 'noop' } : s) }).length);
});

test('find latest per prefix; archive rejects overwrite and source changes', async (t) => {
  const { root, incoming, loaded } = await files(t);
  await writeFile(path.join(incoming, 'NO_old.xml'), '<old/>');
  await utimes(path.join(incoming, 'NO_old.xml'), 1, 1);
  await writeFile(path.join(incoming, 'NO_new.xml'), '<new/>');
  await writeFile(path.join(incoming, 'SFR_one.xml'), '<sfr/>');
  const reports = await findLatestReports({ root_dir: incoming, prefixes: ['NO_', 'SFR_'] }, [root]);
  assert.deepEqual(reports.map((r) => r.filename), ['NO_new.xml', 'SFR_one.xml']);
  await assert.rejects(findLatestReports({ root_dir: incoming, prefixes: ['missing'] }, [root]), { code: 'FILE_NOT_FOUND' });
  await writeFile(path.join(loaded, reports[0].filename), 'existing');
  await assert.rejects(archiveReport(reports[0], loaded, [root]), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(loaded, reports[0].filename), 'utf8'), 'existing');
  await writeFile(reports[1].path, 'changed');
  await assert.rejects(archiveReport(reports[1], loaded, [root]), { code: 'SOURCE_CHANGED' });
  assert.equal(await readFile(reports[1].path, 'utf8'), 'changed');
  const outside = path.join(root, 'outside'); await mkdir(outside);
  try { await symlink(outside, path.join(incoming, 'escape'), 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(findLatestReports({ root_dir: path.join(incoming, 'escape'), prefixes: ['NO_'] }, [incoming]), { code: 'FILESYSTEM_ACCESS_DENIED' });
});

for (const scenario of ['validate_only', 'send', 'invalid', 'wrong_org', 'preflight', 'unknown_send', 'hint_popup', 'organization_card', 'preflight_wrong_org', 'parsed_filename', 'parsed_wrong_path', 'key_identity', 'wrong_report_key', 'key_without_file_proof', 'already_imported', 'external_protocol', 'expand_identity', 'wide_toolbar', 'toolbar_overlay']) {
  test(`real browser workflow against local fixture: ${scenario}`, async (t) => {
    const { root, incoming, loaded } = await files(t);
    await writeFile(path.join(incoming, 'NO_test.xml'), '<TestReport/>');
    let submissions = 0;
    const success = scenario === 'invalid' ? 'Есть ошибки' : 'Ошибок не обнаружено';
    const server = createServer((req, res) => {
      if (req.url === '/sent') { submissions++; res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><body>${scenario === 'hint_popup' && req.url === '/report' ? '<div class="hint" style="position:fixed;inset:0;background:white;z-index:99">Добавить Saby Report в быстрый доступ?<button class="hint-close" onclick="this.parentElement.remove()">Закрыть</button></div>' : ''}<button id="login" onclick="location.href='/cabinet'">Войти</button>
        <button id="org-open" onclick="document.querySelector('#org-panel').hidden=false">Организация</button><div id="org-panel" ${scenario === 'organization_card' ? 'hidden' : ''}><button id="org-close" onclick="this.parentElement.hidden=true">Закрыть</button><div id="org">${['wrong_org', 'preflight_wrong_org'].includes(scenario) ? '000000000000' : '642265347300'}</div></div>
        <button id="import" onclick="if(!document.querySelector('#org-panel').hidden && ${scenario === 'organization_card'})throw new Error('ORGANIZATION_CARD_NOT_CLOSED');document.querySelector('#card').hidden=false;${scenario === 'toolbar_overlay' ? "setTimeout(()=>document.querySelector('#blocking-overlay').remove(),700)" : ''}">Импорт</button>
        <button title="Загрузить" onclick="document.querySelector('#picker').hidden=false">Загрузить</button>
        <div id="picker" hidden><button>С компьютера</button><button>Загрузки</button>
        <div class="FileBrowserComponent__Browser__columnName"><i data-minicard-name="NO_test.xml" data-minicard-path="${path.join(scenario === 'parsed_wrong_path' ? root : incoming, 'NO_test.xml')}"></i><div class="FileBrowserComponent__Browser__columnNameRow" title="NO_test.xml" ondblclick="${scenario === 'already_imported' ? "document.querySelector('#duplicate').hidden=false" : "document.querySelector('#card').hidden=false"};this.parentElement.hidden=true">Распознанное название отчёта</div></div></div>
        <div id="duplicate" hidden>Отчет с такими файлами уже загружался ранее</div><div class="controls-Popup__lastItem"><div id="card" class="report-theme__contrastWrapper" hidden data-report-key="test-card-1">${scenario === 'expand_identity' ? '<button id="expand" onclick="document.querySelector(\'#inn-details\').hidden=false;this.remove()">Развернуть</button><span id="inn-details" hidden>642265347300</span>' : '642265347300'} ${['key_identity', 'wrong_report_key', 'key_without_file_proof'].includes(scenario) ? 'Название отчёта' : 'NO_test.xml'}
        ${scenario === 'toolbar_overlay' ? '<div id="blocking-overlay" style="position:fixed;inset:0;background:white;z-index:100"></div>' : ''}<button id="validate" ${scenario === 'wide_toolbar' ? 'style="position:fixed;left:1100px;top:100px"' : ''} onclick="document.querySelector('#validation').textContent='${success}';${scenario === 'wrong_report_key' ? "document.querySelector('#card').dataset.reportKey='other-card'" : ''}">Проверить</button>
        ${scenario === 'external_protocol' ? '' : '<div id="validation"></div><div id="protocol">Протокол локальной тестовой формы</div>'}
        <button id="send" onclick="fetch('/sent').then(()=>document.querySelector('#status').textContent='${scenario === 'unknown_send' ? 'Отправляется' : 'Отправлен'}')">К отправке</button>
        <div id="status"></div></div></div>${scenario === 'external_protocol' ? '<div id="validation-panel"><div id="validation"></div><div id="protocol">Протокол внешней панели</div></div>' : ''}<button id="reopen">Открыть</button></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template);
    script.steps[3].params.steps = [click('#login')];
    const ui = { dismissible_popups: [{ scope_selector: '.hint', text: 'Добавить Saby Report в быстрый доступ?', close_selector: '.hint-close' }], authority_steps: [], authority_paths: { FNS: '/report' }, organization_selector: '#org', upload_steps: [click('#import')], report_scope_selector: '#card',
      validate_steps: scenario === 'toolbar_overlay' ? template.context.ui.validate_steps : [click('#validate')], validation_status_selector: '#validation', protocol_selector: '#protocol',
      validation_success_text: 'Ошибок не обнаружено', validation_failure_text: 'Есть ошибки',
      reopen_steps: [click('#reopen')], submit_steps: [click('#send')], sent_status_selector: '#status' };
    if (['parsed_filename', 'parsed_wrong_path', 'key_identity', 'wrong_report_key', 'already_imported'].includes(scenario)) ui.upload_steps = structuredClone(template.context.ui.upload_steps);
    if (scenario === 'expand_identity') ui.report_identity_steps = structuredClone(template.context.ui.report_identity_steps);
    if (scenario === 'external_protocol') ui.validation_scope_selector = '#validation-panel';
    if (scenario === 'already_imported') ui.upload_duplicate_text = 'Отчет с такими файлами уже загружался ранее';
    if (['key_identity', 'wrong_report_key', 'key_without_file_proof'].includes(scenario)) { ui.report_identity_mode = 'selected_file_and_key'; ui.report_key_expression = "document.querySelector('#card').dataset.reportKey"; }
    if (scenario === 'organization_card') { ui.organization_steps = [click('#org-open')]; ui.organization_after_steps = [click('#org-close')]; }
    const context = { mode: scenario === 'preflight_wrong_org' ? 'preflight' : ['invalid', 'wrong_org', 'unknown_send'].includes(scenario) ? 'send' : ['hint_popup', 'organization_card', 'parsed_filename', 'parsed_wrong_path', 'key_identity', 'wrong_report_key', 'key_without_file_proof', 'already_imported', 'external_protocol', 'expand_identity', 'wide_toolbar', 'toolbar_overlay'].includes(scenario) ? 'validate_only' : scenario, submit_enabled: true,
      inn: '642265347300', authority_prefixes: null, authority: 'FNS', prefixes: ['NO_'], root_dir: incoming, loaded_dir: loaded,
      login_url: base, authenticated_url: `${base}/cabinet`, report_url: `${base}/report`, submit_timeout_ms: 300, ui };
    let checks = 0;
    const opts = { script, context, checkIp: async () => { checks++; }, allowedRoots: [root],
      artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: `test-${scenario}`, headless: true };
    if (scenario === 'already_imported' || ['wrong_report_key', 'key_without_file_proof'].includes(scenario) || scenario === 'parsed_wrong_path' || scenario === 'invalid' || ['wrong_org', 'preflight_wrong_org'].includes(scenario) || scenario === 'unknown_send') {
      await assert.rejects(executeSbisWorkflow(opts), (error) => {
        assert.equal(error.code, scenario === 'already_imported' ? 'REPORT_ALREADY_IMPORTED' : ['wrong_report_key', 'key_without_file_proof'].includes(scenario) ? 'REPORT_IDENTITY_MISMATCH' : scenario === 'parsed_wrong_path' ? 'FILE_SELECTION_MISMATCH' : scenario === 'invalid' ? 'VALIDATION_ERROR' : ['wrong_org', 'preflight_wrong_org'].includes(scenario) ? 'ORGANIZATION_NOT_VERIFIED' : 'INTERNAL_ERROR');
        assert.equal(error.retryable, false);
        assert.ok(error.partial_context.Rezult_1);
        if (scenario === 'unknown_send') assert.equal(error.partial_context.Rezult_1.state, 'requires_reconciliation');
        return true;
      });
      assert.equal(submissions, scenario === 'unknown_send' ? 1 : 0);
      assert.deepEqual(await readdir(loaded), []);
      assert.equal(await readFile(path.join(incoming, 'NO_test.xml'), 'utf8'), '<TestReport/>');
    } else {
      const result = await executeSbisWorkflow(opts);
      assert.equal(result.steps_executed, 12);
      const data = result.context.Rezult_1;
      assert.equal(data.state, scenario === 'send' ? 'sent' : scenario === 'preflight' ? 'preflight_completed' : 'validated_not_sent');
      assert.equal(submissions, scenario === 'send' ? 1 : 0);
      assert.ok(result.context.artifacts.length);
      if (scenario === 'key_identity') { assert.equal(data.reports[0].file_selection_verified, true); assert.equal(data.reports[0].report_key_verified, true); assert.equal(JSON.stringify(data).includes('test-card-1'), false); }
      if (scenario === 'hint_popup') assert.ok(data.phases.some(p => p.name === 'dismiss_popup'));
      if (scenario === 'send') {
        assert.equal(await readFile(path.join(loaded, 'NO_test.xml'), 'utf8'), '<TestReport/>');
        await assert.rejects(readFile(path.join(incoming, 'NO_test.xml')), { code: 'ENOENT' });
        assert.ok((await readdir(loaded)).some((file) => file.endsWith('.validation.txt')));
      } else assert.equal(await readFile(path.join(incoming, 'NO_test.xml'), 'utf8'), '<TestReport/>');
    }
    assert.equal(checks, 1);
  });
}


test('missing real-report UI bindings fail before any browser or IP request', async () => {
  let checks = 0;
  await assert.rejects(executeSbisWorkflow({ script: template, context: { inn: '642265347300', authority_prefixes: null, prefixes: ['NO_'] },
    checkIp: async () => { checks++; } }), { code: 'UI_BINDING_REQUIRED' });
  assert.equal(checks, 0);
});

test('authority plans validate configuration and retain legacy selection', () => {
  assert.deepEqual(sbisAuthorityPlans({ authority: 'FNS', prefixes: ['NO_'] }), [{ authority: 'FNS', prefixes: ['NO_'] }]);
  for (const plans of [[], [{ authority: 'ALL', prefixes: ['A'] }], [{ authority: 'SFR', prefixes: [] }],
    [{ authority: 'FNS', prefixes: ['A'] }, { authority: 'FNS', prefixes: ['B'] }]]) {
    assert.throws(() => sbisAuthorityPlans({ authority_prefixes: plans }), { code: 'MISSING_PARAMETER' });
  }
});

for (const scenario of ['preflight', 'send', 'invalid_second', 'unknown_second', 'overlap', 'missing_last', 'wrong_second_org']) {
  test(`three authorities, one session: ${scenario}`, async (t) => {
    const { root, incoming, loaded } = await files(t);
    const authorities = ['FNS', 'SFR', 'ROSSTAT'];
    for (const authority of authorities) {
      if (scenario !== 'missing_last' || authority !== 'ROSSTAT') await writeFile(path.join(incoming, `${authority}_test.xml`), `<TestOnly authority="${authority}"/>`);
    }
    let logins = 0; const imports = []; const submissions = []; const events = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const authority = url.pathname.slice(1);
      if (authority === 'cabinet') logins++;
      if (authority === 'import') { imports.push(url.searchParams.get('authority')); res.end('ok'); return; }
      if (authority === 'sent') { submissions.push(url.searchParams.get('authority')); res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const invalid = authority === 'SFR' && scenario === 'invalid_second';
      const unknown = authority === 'SFR' && scenario === 'unknown_second';
      res.end(`<button id="login" onclick="location.href='/cabinet'">Войти</button>
        <div id="org">${authority === 'SFR' && scenario === 'wrong_second_org' ? '000000000000' : '642265347300'}</div>
        <button id="import" onclick="fetch('/import?authority=${authority}');document.querySelector('#card').hidden=false;${scenario === 'toolbar_overlay' ? "setTimeout(()=>document.querySelector('#blocking-overlay').remove(),700)" : ''}">Импорт</button>
        <div id="card" hidden>642265347300 ${authority}_test.xml
          <button id="validate" onclick="document.querySelector('#validation').textContent='${invalid ? 'Ошибка' : 'ОК'}'">Проверить</button>
          <div id="validation"></div><div id="protocol">Протокол ${authority}</div>
          <button id="send" onclick="fetch('/sent?authority=${authority}').then(()=>document.querySelector('#status').textContent='${unknown ? 'Отправляется' : 'Отправлен'}')">Отправить</button>
          <div id="status"></div></div><button id="reopen">Открыть</button>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template);
    script.steps[3].params.steps = [click('#login')];
    const ui = { authority_steps: [], authority_paths: Object.fromEntries(authorities.map(a => [a, `/${a}`])),
      organization_selector: '#org', upload_steps: [click('#import')], report_scope_selector: '#card', validate_steps: [click('#validate')],
      validation_status_selector: '#validation', protocol_selector: '#protocol', validation_success_text: 'ОК', validation_failure_text: 'Ошибка',
      reopen_steps: [click('#reopen')], submit_steps: [click('#send')], sent_status_selector: '#status' };
    const context = { inn: '642265347300', mode: scenario === 'preflight' ? 'preflight' : 'send', submit_enabled: true,
      authority_prefixes: authorities.map(authority => ({ authority, prefixes: [scenario === 'overlap' ? 'FNS_' : `${authority}_`] })),
      root_dir: incoming, loaded_dir: loaded, login_url: base, authenticated_url: `${base}/cabinet`, report_url: base, submit_timeout_ms: 400, ui };
    let ipChecks = 0;
    const opts = { script, context, allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test',
      jobId: `multi-${scenario}`, headless: true, checkIp: async () => { ipChecks++; }, onEvent: e => events.push(e) };
    let result;
    if (['invalid_second', 'unknown_second', 'overlap', 'missing_last', 'wrong_second_org'].includes(scenario)) {
      await assert.rejects(executeSbisWorkflow(opts), error => {
        assert.equal(error.code, { invalid_second: 'VALIDATION_ERROR', unknown_second: 'INTERNAL_ERROR', overlap: 'AUTHORITY_FILE_CONFLICT', missing_last: 'FILE_NOT_FOUND', wrong_second_org: 'ORGANIZATION_NOT_VERIFIED' }[scenario]);
        assert.equal(error.retryable, false); result = error.partial_context.Rezult_1; return true;
      });
    } else {
      const output = await executeSbisWorkflow(opts); result = output.context.Rezult_1;
      assert.equal(output.steps_executed, 24);
      assert.equal(events.filter(e => e.type === 'step_completed').length, 24);
      assert.equal(output.context.artifacts.filter(a => a.filename.startsWith('authority-')).length, 3);
    }
    assert.equal(events[0].execution_steps.length, 24);
    assert.equal(logins, 1); assert.equal(ipChecks, 1);
    assert.deepEqual(result.authorities.map(a => a.authority), authorities);
    assert.equal(result.authority, null);
    if (scenario === 'preflight') {
      assert.deepEqual(submissions, []); assert.deepEqual(imports, []);
      assert.ok(result.authorities.every(a => a.state === 'preflight_completed'));
      assert.deepEqual(result.reports.map(r => r.authority), authorities);
    } else if (['overlap', 'missing_last'].includes(scenario)) {
      assert.deepEqual(imports, []); assert.deepEqual(submissions, []); assert.deepEqual(await readdir(loaded), []);
    } else {
      assert.deepEqual(submissions, scenario === 'wrong_second_org' ? ['FNS'] : scenario === 'unknown_second' ? ['FNS', 'SFR'] : scenario === 'invalid_second' ? ['FNS', 'ROSSTAT'] : authorities);
      assert.equal(result.authorities[0].state, 'sent');
      if (['unknown_second', 'wrong_second_org'].includes(scenario)) {
        assert.equal(result.state, 'requires_reconciliation');
        assert.equal(result.authorities[2].state, 'pending');
        assert.equal(result.reports[2].state, 'selected');
      }
      if (scenario === 'invalid_second') assert.equal(result.authorities[1].state, 'validation_failed');
      if (scenario === 'send') assert.equal(result.state, 'sent');
      for (const r of result.reports) {
        const location = r.state === 'archived' ? loaded : incoming;
        assert.ok(await readFile(path.join(location, r.file_name), 'utf8'));
      }
    }
  });
}

for (const scenario of ['first', 'second', 'missing', 'ambiguous', 'strict_auto', 'account_setup', 'security_setup', 'security_blocked', 'early_navigation']) {
  test(`certificate chooser in the workflow: ${scenario}`, async (t) => {
    const { root, incoming, loaded } = await files(t);
    await writeFile(path.join(incoming, 'NO_test.xml'), '<TestOnly/>');
    const chosen = [];
    const onboarding = ['account_setup', 'security_setup', 'security_blocked'].includes(scenario);
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/cabinet' && !onboarding) chosen.push(url.searchParams.get('inn') || 'auto');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/cabinet' && scenario === 'early_navigation') {
        res.write('<html><head><title>Loading</title></head>');
        setTimeout(() => res.end('<body>Cabinet</body></html>'), 250); return;
      }
      if (url.pathname === '/login') {
        res.end(`<button id="login" onclick="location.href='${scenario === 'strict_auto' ? '/cabinet' : '/chooser'}'">Войти</button>`); return;
      }
      if (url.pathname === '/setup') {
        chosen.push(url.searchParams.get('inn'));
        res.end(scenario === 'account_setup' ? '<div>Регистрация ИП</div><input placeholder="Телефон или почта">'
          : '<div>Настройка безопасности</div><button onclick="location.href=\'/cabinet\'">Пропустить</button>'); return;
      }
      if (url.pathname === '/chooser') {
        const row = (inn) => `<button class="cert-row" onclick="location.href='${onboarding ? '/setup' : '/cabinet'}?inn=${inn}'">ИНН ${inn}</button>`;
        res.end(`<div class="controls-SpoilerView">${row('123456789012')}</div>
          ${row('123456789012')}${row('987654321098')}${scenario === 'ambiguous' ? row('123456789012') : ''}`); return;
      }
      res.end('<div>Раздел отчётов</div>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template); script.steps[3].params.steps = [click('#login')];
    const context = { mode: 'preflight', inn: '123456789012', certificate_inn: scenario === 'second' ? '987654321098' : scenario === 'missing' ? '000000000000' : '123456789012',
      certificate_selection_required: true, skip_security_setup: scenario === 'security_setup', authority_prefixes: null, authority: 'FNS', prefixes: ['NO_'], root_dir: incoming, loaded_dir: loaded,
      login_url: `${base}/login`, authenticated_url: `${base}/cabinet`, report_url: `${base}/report`,
      ui: { certificate_rows_selector: '.cert-row', authority_paths: { FNS: '/report' } } };
    const opts = { script, context, checkIp: async () => {}, allowedRoots: [root], headless: true,
      artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: `certificate-${scenario}` };
    if (['missing', 'ambiguous', 'strict_auto', 'account_setup', 'security_blocked'].includes(scenario)) {
      await assert.rejects(executeSbisWorkflow(opts), { code: { missing: 'CERTIFICATE_NOT_FOUND', ambiguous: 'CERTIFICATE_AMBIGUOUS', strict_auto: 'CERTIFICATE_NOT_VERIFIED', account_setup: 'AUTH_ACCOUNT_SETUP_REQUIRED', security_blocked: 'AUTH_SECURITY_SETUP_REQUIRED' }[scenario] });
      assert.deepEqual(chosen, scenario === 'strict_auto' ? ['auto'] : onboarding ? [context.certificate_inn] : []);
    } else {
      const result = await executeSbisWorkflow(opts);
      assert.deepEqual(chosen, [context.certificate_inn]);
      const auth = result.context.Rezult_1.phases.find(p => p.name === 'auth_ecp');
      assert.equal(auth.certificate_selected, true);
      assert.equal(auth.certificate_inn, context.certificate_inn);
      assert.equal(auth.eligible_certificate_count, 2);
    }
  });
}

test('multiple independent XML cards retain exact file and report-key identity', async (t) => {
  const { root, incoming, loaded } = await files(t);
  const names = ['ONE_test.xml', 'TWO_test.xml'];
  for (const name of names) await writeFile(path.join(incoming, name), '<TestOnly/>');
  const imports = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/import') { imports.push(url.searchParams.get('file')); res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<button id="login" onclick="location.href='/cabinet'">Войти</button><div id="org">642265347300</div>
      <button id="picker-open" onclick="document.querySelector('#picker').hidden=false">Загрузить</button>
      <div id="picker" hidden>${names.map(name => `<div class="file-row" data-minicard-name="${name}" data-minicard-path="${path.join(incoming, name)}" ondblclick="document.querySelector('#card').dataset.reportKey=this.dataset.minicardName;document.querySelector('#card').hidden=false;this.parentElement.hidden=true;fetch('/import?file='+encodeURIComponent(this.dataset.minicardName))">Распознанный отчёт</div>`).join('')}</div>
      <div id="card" hidden>642265347300
        <button id="validate" onclick="document.querySelector('#validation').textContent='OK'">Проверить</button>
        <div id="validation"></div><div id="protocol">Тестовый протокол</div>
      </div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = structuredClone(template);
  script.steps[3].params.steps = [click('#login')];
  const result = await executeSbisWorkflow({ script, context: { mode: 'validate_only', inn: '642265347300', authority_prefixes: null,
    authority: 'FNS', prefixes: ['ONE_', 'TWO_'], allow_multiple: true, root_dir: incoming, loaded_dir: loaded,
    login_url: base, authenticated_url: `${base}/cabinet`, report_url: `${base}/report`,
    ui: { organization_selector: '#org', authority_paths: { FNS: '/report' }, authority_steps: [],
      upload_steps: [click('#picker-open'), { type: 'doubleClick', selectors: [['[data-minicard-name="{{file_name}}"]']], offsetX: 5, offsetY: 5 }],
      report_scope_selector: '#card', report_identity_mode: 'selected_file_and_key', report_key_expression: "document.querySelector('#card').dataset.reportKey",
      validate_steps: [click('#validate')], validation_status_selector: '#validation', protocol_selector: '#protocol',
      validation_success_text: 'OK', validation_failure_text: 'Error' } },
    allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: 'multi-key',
    checkIp: async () => {}, headless: true });
  assert.deepEqual(imports, names);
  assert.equal(result.context.Rezult_1.state, 'validated_not_sent');
  assert.equal(result.context.Rezult_1.reports.length, 2);
  assert.ok(result.context.Rezult_1.reports.every(r => r.file_selection_verified && r.report_key_verified && r.state === 'validated'));
  assert.deepEqual(await readdir(loaded), []);
  assert.deepEqual((await readdir(incoming)).sort(), names);
});
