import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeSbisWorkflow, findLatestReports, archiveReport } from '../src/sbis-workflow.js';
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

for (const scenario of ['validate_only', 'send', 'invalid', 'wrong_org', 'preflight', 'unknown_send']) {
  test(`real browser workflow against local fixture: ${scenario}`, async (t) => {
    const { root, incoming, loaded } = await files(t);
    await writeFile(path.join(incoming, 'NO_test.xml'), '<TestReport/>');
    let submissions = 0;
    const success = scenario === 'invalid' ? 'Есть ошибки' : 'Ошибок не обнаружено';
    const server = createServer((req, res) => {
      if (req.url === '/sent') { submissions++; res.end('ok'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><body><button id="login" onclick="location.href='/cabinet'">Войти</button>
        <button>Налоговая</button><div id="org">${scenario === 'wrong_org' ? '000000000000' : '642265347300'}</div>
        <button id="import" onclick="document.querySelector('#card').hidden=false">Импорт</button>
        <div id="card" hidden>642265347300 NO_test.xml
        <button id="validate" onclick="document.querySelector('#validation').textContent='${success}'">Проверить</button>
        <div id="validation"></div><div id="protocol">Протокол локальной тестовой формы</div>
        <button id="send" onclick="fetch('/sent').then(()=>document.querySelector('#status').textContent='${scenario === 'unknown_send' ? 'Отправляется' : 'Отправлен'}')">К отправке</button>
        <div id="status"></div></div><button id="reopen">Открыть</button></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = structuredClone(template);
    script.steps[3].params.steps = [click('#login')];
    const ui = { authority_steps: [], authority_paths: { FNS: '/report' }, organization_selector: '#org', upload_steps: [click('#import')], report_scope_selector: '#card',
      validate_steps: [click('#validate')], validation_status_selector: '#validation', protocol_selector: '#protocol',
      validation_success_text: 'Ошибок не обнаружено', validation_failure_text: 'Есть ошибки',
      reopen_steps: [click('#reopen')], submit_steps: [click('#send')], sent_status_selector: '#status' };
    const context = { mode: ['invalid', 'wrong_org', 'unknown_send'].includes(scenario) ? 'send' : scenario, submit_enabled: true,
      inn: '642265347300', authority: 'FNS', prefixes: ['NO_'], root_dir: incoming, loaded_dir: loaded,
      login_url: base, authenticated_url: `${base}/cabinet`, report_url: `${base}/report`, submit_timeout_ms: 300, ui };
    let checks = 0;
    const opts = { script, context, checkIp: async () => { checks++; }, allowedRoots: [root],
      artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: `test-${scenario}`, headless: true };
    if (scenario === 'invalid' || scenario === 'wrong_org' || scenario === 'unknown_send') {
      await assert.rejects(executeSbisWorkflow(opts), (error) => {
        assert.equal(error.code, scenario === 'invalid' ? 'VALIDATION_ERROR' : scenario === 'wrong_org' ? 'ORGANIZATION_NOT_VERIFIED' : 'INTERNAL_ERROR');
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
  await assert.rejects(executeSbisWorkflow({ script: template, context: { inn: '642265347300' },
    checkIp: async () => { checks++; } }), { code: 'UI_BINDING_REQUIRED' });
  assert.equal(checks, 0);
});
