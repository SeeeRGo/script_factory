import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { executeJsonWorkflow, computeWorkflowExpression } from '../src/json-workflow.js';
import { validateScript } from '../src/interpreter.js';
import { archiveWorkflowFile, listWorkflowFiles } from '../src/workflow-files.js';
const base = steps => ({ format: 'json-workflow', steps });
async function options(t, script) {
  const root = await mkdtemp(path.join(tmpdir(), 'json-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { script, allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'), publicArtifactBasePath: '/artifacts/test', jobId: 'test', context: {}, root };
}
test('unrelated JSON workflow executes loops, conditions and reusable routines with scoped variables', async t => {
  const script = { ...base([
    { action: 'set', params: { sum: 0, item: 'outside' } },
    { action: 'for_each', as: 'item', index_as: 'index', params: { items: [2, 5, 8] }, steps: [
      { action: 'compute', params: { expression: 'context.item > 3' }, save_as: 'include' },
      { action: 'if', params: { condition: '{{include}}' }, then: [{ action: 'call', routine: 'add', params: { amount: '{{item}}' } }] }
    ] },
    { action: 'compute', params: { expression: '({sum:context.sum, original:context.item, leaked:Object.hasOwn(context,"amount")})' }, save_as: 'answer' }
  ]), routines: { add: [{ action: 'compute', params: { expression: 'context.sum + context.amount' }, save_as: 'sum' }] }, output: { Rezult_1: '{{answer}}' } };
  const events = [];
  const result = await executeJsonWorkflow({ ...await options(t, script), onEvent: e => events.push(e) });
  assert.deepEqual(result.context.Rezult_1, { sum: 13, original: 'outside', leaked: false });
  assert.equal(result.context.sum, undefined);
  assert.equal(events.filter(e => e.type === 'step_added').length, result.steps_executed);
  assert.deepEqual(events.filter(e => e.type === 'step_added').map(e => e.step_index), Array.from({ length: result.steps_executed }, (_, i) => i));
});
test('schema rejects unknown nested actions, calls, unsafe variables and retired site-specific format', () => {
  for (const script of [base([{ action: 'select_authority' }]), base([{ action: 'for_each', as: 'item', steps: [{ action: 'bad' }] }]), base([{ action: 'call', routine: 'missing' }]), base([{ action: 'set', save_as: '__proto__' }]), { format: 'sbis-report', steps: [] }, { ...base([]), output: 'bad' }]) assert.ok(validateScript(script).length);
});
test('pure expressions cannot reach host objects or import code and are time bounded', async () => {
  assert.equal(await computeWorkflowExpression('typeof process+","+typeof require', {}), 'undefined,undefined');
  await assert.rejects(computeWorkflowExpression('({}).constructor.constructor("return process")()', {}), { code: 'EXPRESSION_ERROR' });
  await assert.rejects(computeWorkflowExpression('(()=>{while(true){}})()', {}), { code: 'EXPRESSION_ERROR' });
  await assert.rejects(computeWorkflowExpression('(async()=>{await 0;while(true){}})()', {}), { code: 'EXPRESSION_ERROR' });
  assert.equal(await computeWorkflowExpression('context.value', { value: 'literal ` ${process} " quote' }), 'literal ` ${process} " quote');
});
test('failures run JSON error handler and preserve projected result, private steps hide their values', async t => {
  const script = { ...base([
    { action: 'compute', params: { expression: '"sensitive-internal-key"' }, save_as: 'key', private: true },
    { action: 'fail', params: { error_code: 'CUSTOM_FAILURE', message: 'test' } }
  ]), on_error: [{ action: 'compute', params: { expression: '({code:context.error.code, recovered:true})' }, save_as: 'result' }], output: { Rezult_1: '{{result}}' } };
  const events = [];
  await assert.rejects(executeJsonWorkflow({ ...await options(t, script), onEvent: e => events.push(e) }), e => {
    assert.equal(e.code, 'CUSTOM_FAILURE');
    assert.deepEqual(e.partial_context.Rezult_1, { code: 'CUSTOM_FAILURE', recovered: true });
    assert.equal(e.partial_context.key, undefined);
    return true;
  });
  assert.equal(JSON.stringify(events).includes('sensitive-internal-key'), false);
});
test('cancellation and step timeout stop subsequent actions and prevent error-handler side effects', async t => {
  for (const cancel of [false, true]) {
    const script = { ...base([{ action: 'wait', params: { duration_ms: 5000 }, timeout_ms: 30 }, { action: 'set', params: { forbidden: true } }]), on_error: [{ action: 'set', params: { handler_ran: true } }] };
    const controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), 10) : null;
    await assert.rejects(executeJsonWorkflow({ ...await options(t, script), signal: controller.signal }), error => {
      assert.equal(error.code, cancel ? 'CANCELLED' : 'TIMEOUT_ERROR');
      assert.equal(error.partial_context.forbidden, undefined);
      assert.equal(error.partial_context.handler_ran, cancel ? undefined : true);
      return true;
    });
    clearTimeout(timer);
  }
});
test('generic files keep extension selection in JSON, reject changed files, overwrite and symlink escape', async t => {
  const opts = await options(t, base([]));
  const incoming = path.join(opts.root, 'incoming'), loaded = path.join(opts.root, 'loaded');
  await mkdir(incoming); await mkdir(loaded);
  await writeFile(path.join(incoming, 'plain.csv'), 'a,b');
  await writeFile(path.join(incoming, 'report.xml'), '<xml/>');
  const files = await listWorkflowFiles(incoming, [opts.root]);
  assert.equal(files.length, 2);
  const csv = files.find(f => f.filename === 'plain.csv');
  await writeFile(path.join(loaded, csv.filename), 'existing');
  await assert.rejects(archiveWorkflowFile(csv, loaded, [opts.root]), { code: 'EEXIST' });
  assert.equal(await readFile(csv.path, 'utf8'), 'a,b');
  await writeFile(csv.path, 'changed');
  await assert.rejects(archiveWorkflowFile(csv, loaded, [opts.root]), { code: 'SOURCE_CHANGED' });
  const xml = files.find(f => f.filename.endsWith('.xml'));
  await archiveWorkflowFile(xml, loaded, [opts.root]);
  assert.deepEqual(await readdir(incoming), ['plain.csv']);
  const external = await mkdtemp(path.join(tmpdir(), 'workflow-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  try { await symlink(external, path.join(incoming, 'escape'), 'dir'); } catch (e) { if (e.code === 'EPERM') return; throw e; }
  await assert.rejects(listWorkflowFiles(path.join(incoming, 'escape'), [opts.root]), { code: 'FILESYSTEM_ACCESS_DENIED' });
});
test('another browser scenario from JSON reads a page, branches and creates an artifact in one session', async t => {
  const server = createServer((_req, res) => res.end('<html><body><button onclick="document.querySelector(\'#out\').textContent=\'ready\'">Run</button><div id="out"></div></body></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const script = { ...base([
    { action: 'browser_launch' },
    { action: 'browser_steps', params: { steps: [{ type: 'navigate', url: `http://127.0.0.1:${server.address().port}` }, { type: 'click', selectors: [['button']], offsetX: 10, offsetY: 10 }] } },
    { action: 'browser_wait', params: { expression: 'document.querySelector("#out").innerText === "ready"' } },
    { action: 'browser_eval', params: { expression: 'Promise.resolve(document.querySelector("#out").innerText)' }, save_as: 'text' },
    { action: 'artifact_write', params: { filename: 'result.txt', text: '{{text}}' }, save_as: 'artifact' },
    { action: 'compute', params: { expression: '({text:context.text,artifact:context.artifact.public_url})' }, save_as: 'answer' }
  ]), output: { Rezult_1: '{{answer}}' } };
  const opts = await options(t, script);
  const result = await executeJsonWorkflow(opts);
  assert.deepEqual(result.context.Rezult_1, { text: 'ready', artifact: '/artifacts/test/result.txt' });
  assert.equal(await readFile(path.join(opts.artifactDirectory, 'result.txt'), 'utf8'), 'ready');
});
test('recursive calls are bounded rather than exhausting the process', async t => {
  const script = { ...base([{ action: 'call', routine: 'loop' }]), routines: { loop: [{ action: 'call', routine: 'loop' }] } };
  await assert.rejects(executeJsonWorkflow(await options(t, script)), { code: 'WORKFLOW_LIMIT' });
});

test('browser expressions and waits work on pages restricting eval with CSP and Trusted Types', async t => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Security-Policy', "script-src 'self'; require-trusted-types-for 'script'");
    res.end('<html><body><div id="out">ready</div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const script = { ...base([
    { action: 'browser_launch' },
    { action: 'browser_steps', params: { steps: [{ type: 'navigate', url: `http://127.0.0.1:${server.address().port}` }] } },
    { action: 'browser_eval', params: { expression: 'document.querySelector("#out").textContent' }, save_as: 'text' },
    { action: 'browser_wait', params: { expression: 'document.querySelector("#out").textContent===context.text' } }
  ]), output: { Rezult_1: { text: '{{text}}' } } };
  const result = await executeJsonWorkflow(await options(t, script));
  assert.equal(result.context.Rezult_1.text, 'ready');
});
