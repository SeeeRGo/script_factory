import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeJsonWorkflow } from '../src/json-workflow.js';
import { validateScript } from '../src/interpreter.js';
const template = JSON.parse(await readFile(new URL('../demo/sbis-report-full.json', import.meta.url), 'utf8'));
const click = selector => ({ type: 'click', selectors: [[selector]], offsetX: 10, offsetY: 10 });
const inn = '642265347300';
test('SBIS JSON contains generic operations only, with no server-side site actions', () => {
  assert.deepEqual(validateScript(template), []);
  assert.equal(template.format, 'json-workflow');
  const visit = steps => { for (const step of steps) { assert.notEqual(step.action, 'select_authority'); assert.notEqual(step.action, 'auth_ecp'); for (const key of ['steps', 'then', 'else']) if (step[key]) visit(step[key]); } };
  visit(template.steps); Object.values(template.routines).forEach(visit);
});
for (const scenario of ['validate_only', 'send', 'invalid', 'preflight_three', 'wrong_org', 'wrong_authority', 'wrong_file_path', 'wrong_card', 'ambiguous_certificate', 'expired_only', 'account_setup', 'duplicate', 'multiple_files', 'file_conflict', 'same_card_key', 'unknown_send']) {
  test(`SBIS JSON on real browser fixture: ${scenario}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'sbis-json-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const incoming = path.join(root, 'incoming'), loaded = path.join(root, 'loaded');
    await mkdir(incoming); await mkdir(loaded);
    const names = scenario === 'preflight_three' ? ['FNS_report.xml', 'SFR_report.xml', 'STAT_report.xml'] : scenario === 'multiple_files' || scenario === 'same_card_key' ? ['NO_one.xml', 'AN_two.xml'] : ['NO_one.xml'];
    for (const name of names) await writeFile(path.join(incoming, name), '<TestOnly/>');
    let imported = 0, submitted = 0, checked = 0;
    const server = createServer((req, res) => {
      if (scenario === 'wrong_authority' && req.url === '/report/fns') { res.writeHead(302, { Location: '/report/sfr' }); res.end(); return; }
      if (req.url === '/imported') { imported++; res.end('ok'); return; }
      if (req.url === '/submitted') { submitted++; res.end('ok'); return; }
      if (req.url === '/checked') { checked++; res.end('ok'); return; }
      const origin = `http://127.0.0.1:${server.address().port}`;
      const reopen = new URL(req.url, origin).searchParams.get('name');
      const cardKey = name => scenario === 'same_card_key' ? 'same-key' : `key-${name}`;
      const rows = names.map(name => `<div class="FileBrowserComponent__Browser__columnName"><i style="display:inline-block;width:12px;height:12px" data-minicard-name="${name}" data-minicard-path="${path.join(scenario === 'wrong_file_path' ? loaded : incoming, name)}"></i><div class="FileBrowserComponent__Browser__columnNameRow" ondblclick="document.querySelector('#picker').hidden=true;${scenario === 'duplicate' ? "document.querySelector('#duplicate').hidden=false" : `document.querySelector('#card').hidden=false;document.querySelector('#card').dataset.reportKey='${cardKey(name)}';fetch('/imported')`}">Название отчёта</div></div>`).join('');
      const usable = scenario === 'expired_only' ? '' : `<div class="cert" onclick="location.href='${scenario === 'account_setup' ? '/setup' : '/cabinet'}'">ИНН ${inn}</div>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>Отчеты</title></head><body>
        ${req.url === '/setup' ? 'Регистрация ИП' : ''}
        <button onclick="document.querySelector('#chooser').hidden=false">По ключу подписи</button>
        <div id="chooser" class="chooser" hidden><div class="expired"><div class="cert">ИНН ${inn}</div></div><div class="cert">ИНН 000000000000</div>${usable}${scenario === 'ambiguous_certificate' ? usable : ''}</div>
        <div id="org">${scenario === 'wrong_org' ? '000000000000' : inn}</div>
        <button title="Загрузить" onclick="document.querySelector('#picker').hidden=false">Загрузить</button><div id="picker" hidden><button>С компьютера</button><button>Загрузки</button>${rows}</div>
        <div id="duplicate" hidden>Отчет с такими файлами уже загружался ранее</div>
        <div class="controls-Popup__lastItem"><div id="card" class="report-theme__contrastWrapper" ${reopen ? '' : 'hidden'} data-report-key="${reopen ? cardKey(reopen) : 'before'}">${inn}
        <button id="validate" onclick="fetch('/checked');document.querySelector('#validation-panel').hidden=false;document.querySelector('#validation').textContent='${scenario === 'invalid' ? 'Найденные ошибки' : 'Ошибок не обнаружено'}';${scenario === 'wrong_card' ? "document.querySelector('#card').dataset.reportKey='other-card'" : ''}">Проверить</button>
        <button id="send" onclick="fetch('/submitted').then(()=>document.querySelector('#sent').textContent='${scenario === 'unknown_send' ? 'Отправляется' : 'Отправлено'}')">Отправить</button><div id="sent"></div></div></div>
        <div id="validation-panel" hidden><div id="validation"></div><div id="protocol">Текст тестовой проверки</div></div>
      </body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template);
    // Bound waits in negative fixtures; production JSON retains its real timeouts.
    const shorten = steps => { for (const step of steps) { if (step.action === 'browser_wait') { step.params.timeout_ms = 500; step.timeout_ms = 3000; } for (const key of ['steps', 'then', 'else']) if (step[key]) shorten(step[key]); } };
    shorten(script.steps); Object.values(script.routines).forEach(shorten);
    const ui = { ...script.context.ui, certificate_rows_selector: '#chooser .cert', certificate_unusable_selector: '.expired',
      organization_steps: [{ type: 'navigate', url: `${origin}/organization` }], organization_selector: '#org',
      authority_paths: { FNS: '/fns', SFR: '/sfr', ROSSTAT: '/stat' }, authority_steps: [],
      report_key_expression: "document.querySelector('#card').dataset.reportKey",
      validation_scope_selector: '#validation-panel', validation_status_selector: '#validation', protocol_selector: '#protocol',
      validation_success_text: 'Ошибок не обнаружено', validation_failure_text: 'Найденные ошибки',
      reopen_steps: [{ type: 'navigate', url: `${origin}/reopen?name={{file_name}}` }], submit_steps: [click('#send')],
      sent_status_selector: '#sent', sent_status_text: 'Отправлено' };
    const authority_prefixes = scenario === 'preflight_three' ? [{ authority: 'FNS', prefixes: ['FNS_'] }, { authority: 'SFR', prefixes: ['SFR_'] }, { authority: 'ROSSTAT', prefixes: ['STAT_'] }]
      : scenario === 'file_conflict' ? [{ authority: 'FNS', prefixes: ['NO_'] }, { authority: 'SFR', prefixes: ['NO_'] }]
      : [{ authority: 'FNS', prefixes: names.length === 2 ? ['NO_', 'AN_'] : ['NO_'] }];
    const events = [];
    const opts = { onEvent: event => events.push(event), script, context: { mode: scenario === 'preflight_three' ? 'preflight' : ['send', 'unknown_send'].includes(scenario) ? 'send' : 'validate_only',
      submit_enabled: ['send', 'unknown_send'].includes(scenario), inn, certificate_inn: inn, certificate_selection_required: true,
      login_url: `${origin}/login`, report_url: `${origin}/report`, authenticated_url: `${origin}/cabinet`, root_dir: incoming, loaded_dir: loaded, authority_prefixes, ui },
      allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: `job-${scenario}`, checkIp: async () => ({ ip_matches_expected: true }) };
    const codes = { invalid: 'VALIDATION_ERROR', wrong_org: 'ORGANIZATION_NOT_VERIFIED', wrong_authority: 'AUTHORITY_NOT_VERIFIED', wrong_file_path: 'FILE_SELECTION_MISMATCH', wrong_card: 'REPORT_IDENTITY_MISMATCH', ambiguous_certificate: 'CERTIFICATE_AMBIGUOUS', expired_only: 'CERTIFICATE_NOT_FOUND', account_setup: 'AUTH_ACCOUNT_SETUP_REQUIRED', duplicate: 'REPORT_ALREADY_IMPORTED', file_conflict: 'AUTHORITY_FILE_CONFLICT', same_card_key: 'REPORT_BUNDLE_REQUIRED', unknown_send: 'WORKFLOW_ERROR' };
    if (codes[scenario]) {
      await assert.rejects(executeJsonWorkflow(opts), e => {
        assert.equal(e.code, codes[scenario]);
        assert.equal(e.retryable, false);
        assert.equal(e.partial_context.Rezult_1.state, scenario === 'invalid' ? 'validation_failed' : scenario === 'unknown_send' ? 'requires_reconciliation' : 'failed');
        if (scenario === 'invalid') assert.ok(e.partial_context.Rezult_1.reports[0].validation_protocol);
        return true;
      });
      assert.equal(submitted, scenario === 'unknown_send' ? 1 : 0);
      assert.deepEqual(await readdir(loaded), []);
    } else {
      const result = await executeJsonWorkflow(opts);
      assert.equal(result.context.Rezult_1.state, scenario === 'send' ? 'sent' : scenario === 'preflight_three' ? 'preflight_completed' : 'validated_not_sent');
      assert.equal(result.context.Rezult_1.reports.length, names.length);
      assert.equal(submitted, scenario === 'send' ? 1 : 0);
      assert.equal(imported, scenario === 'preflight_three' ? 0 : names.length);
      if (scenario === 'send') { assert.equal((await readdir(incoming)).length, 0); assert.equal((await readdir(loaded)).length, 2); assert.equal(checked, 2); }
      else assert.deepEqual((await readdir(incoming)).sort(), [...names].sort());
      if (scenario === 'preflight_three') assert.equal(result.context.Rezult_1.phases.filter(p => p.name === 'select_authority' && p.organization_verified).length, 3);
      assert.equal(JSON.stringify(result.context.Rezult_1).includes('key-NO'), false);
      assert.equal(JSON.stringify(events).includes('key-NO_one.xml'), false);
    }
  });
}
