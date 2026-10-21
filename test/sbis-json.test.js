import test from 'node:test';
import { readdirSync } from 'node:fs';
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
for (const scenario of ['validation_two_reports','validation_full_panel','validation_delayed_details','validation_header_only','send_multiple_tabs', 'send_multiple_tab_mismatch', 'workstation_not_ready', 'send_missing_prefixes', 'upload_bundle_only', 'validate_only', 'known_popup', 'ip_profile', 'collapsed_requisites', 'license_required', 'license_wrong_card', 'license_debt_denied', 'license_debt_allowed', 'license_debt_price_changed', 'license_debt_late_price', 'license_debt_contradiction', 'send', 'send_accepted', 'invalid', 'mixed_validation', 'preflight_three', 'send_three_partial', 'wrong_org', 'wrong_authority', 'wrong_file_path', 'wrong_card', 'ambiguous_certificate', 'expired_only', 'account_setup', 'duplicate', 'multiple_files', 'file_conflict', 'same_card_key', 'unknown_send']) {
  test(`SBIS JSON on real browser fixture: ${scenario}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'sbis-json-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const incoming = path.join(root, 'incoming'), loaded = path.join(root, 'loaded');
    await mkdir(incoming); await mkdir(loaded);
    const names = scenario.startsWith('send_multiple_') ? ['NO_one.xml', 'NO_two.xml', 'NO_three.xml'] : scenario === 'upload_bundle_only' ? ['NO_one.xml','PART8_one.xml','PART9_one.xml'] : ['preflight_three','send_three_partial'].includes(scenario) ? ['FNS_report.xml', 'SFR_report.xml', 'STAT_report.xml'] : scenario === 'multiple_files' || scenario === 'same_card_key' || scenario === 'mixed_validation' || scenario==='validation_two_reports' ? ['NO_one.xml', 'AN_two.xml'] : ['NO_one.xml'];
    for (const name of names) await writeFile(path.join(incoming, name), scenario==='upload_bundle_only' && name==='NO_one.xml' ? '<TestOnly part8="PART8_one.xml" part9="PART9_one.xml"/>' : '<TestOnly/>');
    const submittedKeys = []; let importsAtFirstSend;
    let imported = 0, submitted = 0, checked = 0, dismissed = 0, organizationOpened = 0, requisitesExpanded = 0, sendAttempts = 0;
    const server = createServer((req, res) => {
      if (scenario === 'wrong_authority' && req.url === '/report/fns') { res.writeHead(302, { Location: '/report/sfr' }); res.end(); return; }
      if (req.url === '/imported') { imported++; res.end('ok'); return; }
      if (req.url === '/send-attempted') { sendAttempts++; res.end('ok'); return; }
      if (req.url.startsWith('/submitted')) { submittedKeys.push(new URL(req.url, 'http://localhost').searchParams.get('key')); importsAtFirstSend ??= imported; submitted++; res.end('ok'); return; }
      if (req.url === '/checked') { checked++; res.end('ok'); return; }
      if (req.url === '/dismissed') { dismissed++; res.end('ok'); return; }
      if (req.url === '/expanded') { requisitesExpanded++; res.end('ok'); return; }
      if (req.url === '/org-opened') { organizationOpened++; res.end('ok'); return; }
      const origin = `http://127.0.0.1:${server.address().port}`;
      const reopen = new URL(req.url, origin).searchParams.get('name');
      const licenseStops = scenario === 'send_three_partial' && reopen?.startsWith('SFR_');
      const cardKey = name => scenario === 'same_card_key' ? 'same-key' : `key-${name}`;
      const rows = scenario==='upload_bundle_only' ? '<table>'+names.map(name=>`<tr><td><span style="display:inline-block;width:20px;height:20px" class="js-controls-ListView__itemCheckBox" onclick="this.closest('tr').classList.toggle('controls-ListView__item__multiSelected')">□</span></td><td class="FileBrowserComponent__Browser__columnName"><i style="display:inline-block;width:12px;height:12px" data-minicard-name="${name}" data-minicard-path="${path.join(incoming,name)}"></i><div class="FileBrowserComponent__Browser__columnNameRow">Часть отчёта</div></td></tr>`).join('')+`</table><button data-name="FolderBrowserComponent__StartLoadButton" onclick="document.querySelector('#picker').hidden=true;document.querySelector('#card').hidden=false;document.querySelector('#card').dataset.reportKey='key-NO_one.xml';fetch('/imported')">Загрузить комплект</button>` : names.map(name => `<div class="FileBrowserComponent__Browser__columnName"><i style="display:inline-block;width:12px;height:12px" data-minicard-name="${name}" data-minicard-path="${path.join(scenario === 'wrong_file_path' ? loaded : incoming, name)}"></i><div class="FileBrowserComponent__Browser__columnNameRow" ondblclick="document.querySelector('#picker').hidden=true;${scenario === 'duplicate' ? "document.querySelector('#duplicate').hidden=false" : `document.querySelector('#card').hidden=false;document.querySelector('#card').dataset.reportKey='${cardKey(name)}';fetch('/imported')`}">Название отчёта</div></div>`).join('');
      const protocolCase=scenario.startsWith('validation_');
      const protocolDetails='Главная\nНекорректно указано лицо, подписывающее документ\nДля отчёта ИП удалите ФИО руководителя';
      const usable = scenario === 'expired_only' ? '' : `<div class="cert" onclick="location.href='${scenario === 'account_setup' ? '/setup' : '/cabinet'}'">ИНН ${inn}</div>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>Отчеты</title></head><body>
        ${req.url === '/setup' ? 'Регистрация ИП' : ''}
        <button onclick="${scenario === 'workstation_not_ready' ? "document.body.innerHTML='Компьютер не готов к работе <button>Начать проверку</button>'" : "document.querySelector('#chooser').hidden=false"}">По ключу подписи</button>
        <div id="chooser" class="chooser" hidden><div class="expired"><div class="cert">ИНН ${inn}</div></div><div class="cert">ИНН 000000000000</div>${usable}${scenario === 'ambiguous_certificate' ? usable : ''}</div>
        ${scenario === 'ip_profile' ? `<span onclick="if(event.isTrusted){document.querySelector('#org').hidden=false;fetch('/org-opened')}">Тестовый кабинет, ИП</span>` : ''}
        <div id="org" ${scenario === 'ip_profile' ? 'hidden' : ''}>${scenario === 'wrong_org' ? '000000000000' : inn}</div>
        <button title="Загрузить" onclick="document.querySelector('#picker').hidden=false">Загрузить</button><div id="picker" hidden><button>С компьютера</button><button>Загрузки</button>${rows}</div>
        <div id="duplicate" hidden>Отчет с такими файлами уже загружался ранее</div>
        <div class="controls-Popup__lastItem"><div id="card" class="report-theme__contrastWrapper" ${reopen ? '' : 'hidden'} data-report-key="${reopen ? cardKey(reopen) : 'before'}">${scenario === 'collapsed_requisites' ? `<input id="card-inn" readonly hidden value="${inn}"><button onclick="if(event.isTrusted){document.querySelector('#card-inn').hidden=false;this.textContent='Свернуть';fetch('/expanded')}">Развернуть</button>` : inn}
        <button id="validate" title="Проверить" onclick="fetch('/checked');document.querySelector('#validation-panel').hidden=false;document.querySelector('#validation').textContent=${scenario === 'mixed_validation' ? "(document.querySelector('#card').dataset.reportKey==='key-NO_one.xml'?'Найденные ошибки':'Ошибок не обнаружено')" : (scenario === 'invalid' || protocolCase ? "'Найденные ошибки'" : "'Ошибок не обнаружено'")};${scenario==='validation_two_reports'?"document.querySelector('#protocol-details').textContent=document.querySelector('#card').dataset.reportKey.includes('NO_one')?'Главная: ошибка первого файла':'Раздел 2: ошибка второго файла'":''};${scenario==='validation_delayed_details'?"setTimeout(()=>document.querySelector('#protocol-details').textContent='Главная\\nНекорректно указано лицо, подписывающее документ\\nДля отчёта ИП удалите ФИО руководителя',150)":''};${scenario === 'wrong_card' ? "document.querySelector('#card').dataset.reportKey='other-card'" : ''}">Проверить</button>
        <button id="send" onclick="${scenario.startsWith('license_debt') ? "document.querySelector('#license-debt-block').hidden=false;fetch('/send-attempted')" : (['license_required','license_wrong_card'].includes(scenario)||licenseStops) ? `document.querySelector('#license-block').hidden=false;${scenario === 'license_wrong_card' ? "document.querySelector('#card').dataset.reportKey='other-card';" : ''}fetch('/send-attempted')` : `fetch('/submitted?key='+encodeURIComponent(document.querySelector('#card').dataset.reportKey)).then(()=>document.querySelector('#sent').textContent='${scenario === 'unknown_send' ? 'Отправляется' : scenario === 'send_accepted' ? 'Отчет сдан' : 'Отправлено'}')`}">Отправить</button>${((['license_required','license_wrong_card'].includes(scenario)||licenseStops)||scenario.startsWith('license_debt')) ? `<div class="np-StickerTab__main">Отчет создан</div><aside id="license-block" hidden>Но нет лицензии &quot;Отчетность&quot;</aside>` : ''}<div id="sent"></div></div></div>
        ${scenario.startsWith('license_debt') ? "<aside id='license-debt-block' hidden><span>Вы используете &quot;Отчетность&quot; в долг</span><button class='licenseRestriction-buttonBlock__refuseButton' title='В долг' onclick=\"fetch('/submitted').then(()=>document.querySelector('#sent').textContent='Отправлено')\">В долг</button><button class='licenseRestriction-buttonBlock__payButton'>Оплатить 2 500 ₽</button></aside>" : ''}${protocolCase ? `<div id="validation-panel" class="journal-react__view journal-react__background_pink" hidden><div class="tw-box-border tw-h-full tw-flex tw-flex-col controls-padding_bottom-m"><div id="validation" class="controls-Header__caption"></div><div>1</div><div>21 окт'26 14:41</div></div><div class="journalReact-Folder__title">Отчёт НДС, разделы проверки</div><div id="protocol-details" data-qa="journal_check_result">${scenario==='validation_full_panel'?protocolDetails:''}</div><div hidden>Старая скрытая ошибка</div></div>` : '<div id="validation-panel" hidden><div id="validation"></div><div id="protocol">Текст тестовой проверки</div></div>'}
        ${scenario === 'license_debt_late_price' ? `<script>document.querySelector('.licenseRestriction-buttonBlock__refuseButton').addEventListener('pointerdown',()=>{document.querySelector('.licenseRestriction-buttonBlock__payButton').textContent='Оплатить 3 000 ₽'})</script>` : ''}
        ${scenario === 'license_debt_contradiction' ? `<script>document.querySelector('#send').addEventListener('click',()=>{document.querySelector('#sent').textContent='Отчет сдан'})</script>` : ''}
        ${scenario === 'known_popup' && req.url.startsWith('/report') ? `<div class="controls-ConfirmationTemplate" style="position:fixed;inset:0;z-index:999;background:white">
          Добавить Saby Report в быстрый<br>доступ?
          <button class="controls-CloseButton__close" onclick="if(event.isTrusted){this.parentElement.remove();document.querySelector('#email-hint').hidden=false;fetch('/dismissed')}">Закрыть</button>
        </div><div id="email-hint" class="controls-ConfirmationTemplate controls-Popup__lastItem controls-DialogTemplate authRemind-AddRuEmailDialog" hidden style="position:fixed;inset:0;z-index:999;background:white">
          Подтвержденный Email не надёжен
          <button class="controls-CloseButton__close" title="Закрыть" onclick="if(event.isTrusted){this.parentElement.remove();fetch('/dismissed')}">Закрыть</button>
        </div><script>document.addEventListener('click',e=>{if([...document.querySelectorAll('.controls-ConfirmationTemplate')].some(p=>!p.hidden)&&!e.target.closest('.controls-ConfirmationTemplate')){e.preventDefault();e.stopImmediatePropagation()}},true)</script>` : ''}
        ${scenario === 'ip_profile' && req.url === '/organization' ? `<div id="late-email-hint" class="controls-DialogTemplate authRemind-AddRuEmailDialog" hidden style="position:fixed;inset:0;z-index:999;background:white">
          Подтвержденный Email не надёжен
          <button class="controls-CloseButton__close" title="Закрыть" onclick="if(event.isTrusted){this.parentElement.remove();fetch('/dismissed')}">Закрыть</button>
        </div><script>setTimeout(()=>document.querySelector('#late-email-hint').hidden=false,500);document.addEventListener('click',e=>{const p=document.querySelector('#late-email-hint');if(p&&!p.hidden&&!e.target.closest('#late-email-hint')){e.preventDefault();e.stopImmediatePropagation()}},true)</script>` : ''}
      </body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template);
    // Bound waits in negative fixtures; production JSON retains its real timeouts.
    const fixtureWaitMs = Number(process.env.BROWSER_TEST_WAIT_MS || 500);
    const shorten = steps => { for (const step of steps) { if (step.action === 'browser_wait') { step.params.timeout_ms = fixtureWaitMs; step.timeout_ms = fixtureWaitMs + 2500; } for (const key of ['steps', 'then', 'else']) if (step[key]) shorten(step[key]); } };
    shorten(script.steps); Object.values(script.routines).forEach(shorten);
    const ui = { ...script.context.ui, certificate_rows_selector: '#chooser .cert', certificate_unusable_selector: '.expired',
      organization_steps: scenario === 'ip_profile' ? [{ type: 'navigate', url: `${origin}/organization` }, ...script.context.ui.organization_steps.slice(1)] : [{ type: 'navigate', url: `${origin}/organization` }], organization_selector: '#org',
      authority_paths: { FNS: '/fns', SFR: '/sfr', ROSSTAT: '/stat' }, authority_steps: [],
      report_key_expression: "document.querySelector('#card').dataset.reportKey",
      validation_scope_selector: '#validation-panel', validation_status_selector: '#validation', protocol_selector: scenario.startsWith('validation_') ? script.context.ui.protocol_selector : '#protocol', validation_error_selector: scenario.startsWith('validation_') ? '[data-qa="journal_check_result"]' : '#protocol',
      validation_success_text: 'Ошибок не обнаружено', validation_failure_text: 'Найденные ошибки',
      reopen_steps: scenario.startsWith('send_multiple_') ? (scenario==='send_multiple_tab_mismatch' ? [{type:'waitForExpression',expression:"(document.querySelector('#card').dataset.reportKey='wrong-card',true)"}] : script.context.ui.reopen_steps) : [{ type: 'navigate', url: `${origin}/reopen?name={{file_name}}` }], submit_steps: [click('#send')],
      current_card_scope_selector:'#card', sent_scope_selector:'#card', sent_status_selector: '#sent', sent_status_text: 'Отправлено' };
    const authority_prefixes = scenario === 'send_missing_prefixes' ? [{authority:'FNS',prefixes:['NO_', 'ABSENT_']},{authority:'SFR',prefixes:['POVD'],ui:{organization_selector:null}}] : ['preflight_three','send_three_partial'].includes(scenario) ? [{ authority: 'FNS', prefixes: ['FNS_'] }, { authority: 'SFR', prefixes: ['SFR_'] }, { authority: 'ROSSTAT', prefixes: ['STAT_'] }]
      : scenario === 'file_conflict' ? [{ authority: 'FNS', prefixes: ['NO_'] }, { authority: 'SFR', prefixes: ['NO_'] }]
      : scenario==='upload_bundle_only' ? [{authority:'FNS',prefixes:['NO_','PART8_','PART9_'],bundle_files:true}] : [{ authority: 'FNS', prefixes: names.length === 2 ? ['NO_', 'AN_'] : ['NO_'] }];
    if (scenario === 'workstation_not_ready') {
      const wait = script.steps.find(s => s.id === 'sbis_run_reports').then.find(s => s.save_as === 'auth_choice_ready');
      wait.params.timeout_ms = 250;
    }
    const events = []; let closedReportTabs = 0;
    const opts = { onEvent: event => {
      events.push(event);
      if(scenario==='send_multiple_tabs'&&event.type==='step_started'&&event.step_id==='sbis_report_tab_close_action'){
        closedReportTabs++;
        assert.equal(readdirSync(loaded).filter(name=>name.endsWith('.xml')).length,closedReportTabs,'The report must be archived before its tab is closed');
      }
    }, script, context: { mode: scenario==='upload_bundle_only' ? 'upload_only' : scenario === 'preflight_three' ? 'preflight' : ['send_multiple_tabs', 'send_multiple_tab_mismatch', 'send_missing_prefixes', 'send', 'send_accepted', 'unknown_send', 'license_required', 'license_wrong_card', 'license_debt_denied', 'license_debt_allowed', 'license_debt_price_changed','license_debt_late_price','license_debt_contradiction','send_three_partial'].includes(scenario) ? 'send' : 'validate_only',
      submit_enabled: ['send_multiple_tabs', 'send_multiple_tab_mismatch', 'send_missing_prefixes', 'send', 'send_accepted', 'unknown_send', 'license_required', 'license_wrong_card', 'license_debt_denied', 'license_debt_allowed', 'license_debt_price_changed','license_debt_late_price','license_debt_contradiction','send_three_partial'].includes(scenario), inn, certificate_inn: inn, certificate_selection_required: true,
      // The fixture picker already displays incoming, including on Windows drive C.
      upload_directory_steps: [{ type: 'waitForExpression', expression: 'true' }],
      login_url: `${origin}/login`, report_url: `${origin}/report`, authenticated_url: `${origin}/cabinet`, root_dir: incoming, loaded_dir: loaded, license_debt_enabled:['license_debt_allowed','license_debt_price_changed','license_debt_late_price'].includes(scenario), license_debt_expected_amount:scenario==='license_debt_price_changed'?1000:2500, authority_prefixes, ui },
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: process.env.BROWSER_HEADLESS !== 'false', allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: `job-${scenario}`, checkIp: async () => ({ ip_matches_expected: true }) };
    const codes = { validation_two_reports:'VALIDATION_ERROR', validation_full_panel:'VALIDATION_ERROR',validation_delayed_details:'VALIDATION_ERROR',validation_header_only:'VALIDATION_PROTOCOL_NOT_READY', send_multiple_tab_mismatch:'REPORT_IDENTITY_MISMATCH', workstation_not_ready:'WORKFLOW_ERROR', mixed_validation:'VALIDATION_ERROR', send_three_partial:'REPORTING_LICENSE_REQUIRED', license_debt_late_price:'LICENSE_PRICE_CHANGED',license_debt_contradiction:'REQUIRES_RECONCILIATION', license_debt_denied:'REPORTING_LICENSE_CONFIRMATION_REQUIRED',license_debt_price_changed:'LICENSE_PRICE_CHANGED', license_wrong_card:'REPORT_IDENTITY_MISMATCH', license_required: 'REPORTING_LICENSE_REQUIRED', invalid: 'VALIDATION_ERROR', wrong_org: 'ORGANIZATION_NOT_VERIFIED', wrong_authority: 'AUTHORITY_NOT_VERIFIED', wrong_file_path: 'FILE_SELECTION_MISMATCH', wrong_card: 'REPORT_IDENTITY_MISMATCH', ambiguous_certificate: 'CERTIFICATE_AMBIGUOUS', expired_only: 'CERTIFICATE_NOT_FOUND', account_setup: 'AUTH_ACCOUNT_SETUP_REQUIRED', duplicate: 'REPORT_ALREADY_IMPORTED', file_conflict: 'AUTHORITY_FILE_CONFLICT', same_card_key: 'REPORT_BUNDLE_REQUIRED', unknown_send: 'WORKFLOW_ERROR' };
    const checkSavedResult = async projection => {
      const files = projection.artifacts.filter(a => /^result-\d+\.json$/.test(a.filename));
      assert.ok(files.length);
      const text = await readFile(files.at(-1).local_path, 'utf8');
      const records=Object.fromEntries(Object.entries(projection).filter(([k])=>/^Rezult_[1-9]\d*$/.test(k)));
      assert.deepEqual(JSON.parse(text), records);
      for(const report of Object.values(records))for(const value of Object.values(report))assert.ok(value===null||['string','number','boolean'].includes(typeof value));
      assert.equal(text.includes('key-NO'), false);
    };
    if (codes[scenario]) {
      let partial;
      await assert.rejects(executeJsonWorkflow(opts), e => {
        partial = e.partial_context;
        assert.equal(e.code, codes[scenario]);
        assert.equal(e.retryable, false);
        if (scenario === 'workstation_not_ready') {
          assert.match(e.message, /Шаг «Дождаться списка подписей либо завершения автоматического входа»: Waiting failed: 250ms exceeded/);
          assert.equal(e.step_id, 'sbis_run_reports_then_11');
        }
        const report=Object.values(e.partial_context).find(r=>r?.error_code===codes[scenario]);
        if(scenario==='file_conflict')assert.equal(report,undefined);else assert.ok(report,'An error after selection must preserve the affected report result');
        if(report)assert.equal(report.state, scenario==='license_debt_contradiction'?'requires_reconciliation':scenario.startsWith('license_debt')?'license_confirmation_required':['license_required','send_three_partial'].includes(scenario) ? 'license_required' : ['invalid','mixed_validation','validation_full_panel','validation_delayed_details','validation_two_reports'].includes(scenario) ? 'validation_failed' : ['unknown_send','license_wrong_card'].includes(scenario) ? 'requires_reconciliation' : ['workstation_not_ready','wrong_org','wrong_authority','ambiguous_certificate','expired_only','account_setup'].includes(scenario)?'not_processed':'failed');
        if (scenario === 'invalid') { assert.ok(e.partial_context.Rezult_1.validation_protocol); assert.match(e.partial_context.Rezult_1.error_message,/Текст тестовой проверки/); }
        if(['validation_full_panel','validation_delayed_details'].includes(scenario)){
          assert.match(e.message,/Некорректно указано лицо, подписывающее документ/);
          assert.match(e.partial_context.Rezult_1.error_message,/Главная[\s\S]*Некорректно указано лицо[\s\S]*удалите ФИО руководителя/);
          assert.equal(e.partial_context.Rezult_1.error_message.includes('Старая скрытая ошибка'),false);
        }
        return true;
      });
      await checkSavedResult(partial);
      if(scenario==='validation_two_reports'){
        const records=Object.values(partial).filter(r=>r?.file_name);
        const first=records.find(r=>r.file_name==='NO_one.xml'),second=records.find(r=>r.file_name==='AN_two.xml');
        assert.match(first.error_message,/ошибка первого файла/);assert.doesNotMatch(first.error_message,/второго/);
        assert.match(second.error_message,/ошибка второго файла/);assert.doesNotMatch(second.error_message,/первого/);
        assert.equal(imported,2);assert.equal(submitted,0);
      }
      if(['validation_full_panel','validation_delayed_details'].includes(scenario)){
        const proto=(await readdir(opts.artifactDirectory)).find(n=>n.startsWith('validation-'));
        const text=await readFile(path.join(opts.artifactDirectory,proto),'utf8');
        assert.match(text,/Для отчёта ИП удалите ФИО руководителя/);
        assert.equal(text,partial.Rezult_1.error_message);
      }
      if(scenario==='validation_header_only')assert.equal((await readdir(opts.artifactDirectory)).some(n=>n.startsWith('validation-')),false);
      assert.equal(submitted, ['unknown_send','send_three_partial'].includes(scenario) ? 1 : 0);
      if (scenario === 'send_multiple_tab_mismatch') { assert.equal(sendAttempts,0); assert.equal(submitted,0); assert.equal(imported,3); }
      if (scenario === 'license_wrong_card') { assert.equal(sendAttempts,1); assert.equal(partial.Rezult_1.report_state,'submission_unknown'); }
      if (scenario === 'license_required') { assert.equal(sendAttempts, 1); assert.equal(partial.Rezult_1.report_state, 'validated'); assert.ok(partial.Rezult_1.validation_protocol); }
      if(scenario==='mixed_validation'){assert.equal(partial.Rezult_1.state,'validation_failed');assert.equal(partial.Rezult_2.state,'validated_not_sent');assert.equal(partial.Rezult_2.error_code,null);assert.equal(partial.Rezult_2.error_message,null);}
      if(scenario==='send_three_partial'){
        assert.equal(partial.Rezult_1.state,'sent');assert.equal(partial.Rezult_1.section_name,'ФНС');assert.equal(partial.Rezult_1.error_code,null);
        assert.equal(partial.Rezult_2.state,'license_required');assert.equal(partial.Rezult_2.section_name,'СФР');
        assert.equal(partial.Rezult_3.state,'not_processed');assert.equal(partial.Rezult_3.section_name,null);
        assert.equal((await readdir(loaded)).length,2);
      }else assert.deepEqual(await readdir(loaded), []);
    } else {
      const result = await executeJsonWorkflow(opts);
      if(scenario==='send_multiple_tabs'){
        assert.equal(imported,3);assert.equal(importsAtFirstSend,3);
        assert.deepEqual([...submittedKeys].sort(),names.map(n=>'key-'+n).sort());
        for(let i=1;i<=3;i++){assert.equal(result.context['Rezult_'+i].state,'sent');assert.equal(result.context['Rezult_'+i].section_name,'ФНС');}
        assert.equal(events.filter(e=>e.type==='step_completed'&&e.action==='browser_tab').length,9);
      }
      if(scenario==='send_accepted') assert.equal(result.context.Rezult_1.sbis_status,'Отчет сдан');
      if(scenario==='license_debt_allowed'){assert.equal(result.context.Rezult_1.license_requires_confirmation,false);assert.equal(result.context.Rezult_1.license_continuation,'debt');}
      await checkSavedResult(result.context);
      assert.equal(result.context.Rezult_1.state, ['send_multiple_tabs','send_missing_prefixes','send','send_accepted','license_debt_allowed'].includes(scenario) ? 'sent' : scenario === 'preflight_three' ? 'preflight_completed' : scenario==='upload_bundle_only' ? 'uploaded_not_sent' : 'validated_not_sent');
      assert.equal(Object.keys(result.context).filter(k=>/^Rezult_/.test(k)).length,scenario==='upload_bundle_only'?1:names.length);
      for(const record of Object.values(result.context).filter(r=>r?.file_name))assert.equal(record.section_name,scenario==='preflight_three'?null:'ФНС');
      assert.equal(submitted, scenario==='send_multiple_tabs'?3:['send_missing_prefixes','send','send_accepted','license_debt_allowed'].includes(scenario) ? 1 : 0);
      assert.equal(imported, scenario === 'preflight_three' ? 0 : scenario==='upload_bundle_only'?1:names.length);
      if(scenario==='upload_bundle_only'){assert.equal(checked,0);assert.equal(result.context.Rezult_1.file_count,3);assert.equal((await readdir(incoming)).length,3);assert.deepEqual(await readdir(loaded),[]);}
      if (scenario === 'collapsed_requisites') assert.equal(requisitesExpanded, 1);
      if (scenario === 'known_popup') assert.ok(dismissed >= 2);
      if (scenario === 'ip_profile') { assert.ok(organizationOpened > 0); assert.ok(dismissed > 0); }
      if(scenario==='send_multiple_tabs'){assert.equal((await readdir(incoming)).length,0);assert.equal((await readdir(loaded)).length,6);assert.equal(checked,6);}
      else if (['send_missing_prefixes','send','send_accepted','license_debt_allowed'].includes(scenario)) { assert.equal((await readdir(incoming)).length, 0); assert.equal((await readdir(loaded)).length, 2); assert.equal(checked, 2); }
      else assert.deepEqual((await readdir(incoming)).sort(), [...names].sort());
      if (scenario === 'preflight_three') assert.deepEqual([result.context.Rezult_1.authority,result.context.Rezult_2.authority,result.context.Rezult_3.authority],['FNS','SFR','ROSSTAT']);
      assert.equal(JSON.stringify(result.context.Rezult_1).includes('key-NO'), false);
      assert.equal(JSON.stringify(events).includes('key-NO_one.xml'), false);
    }
  });
}
