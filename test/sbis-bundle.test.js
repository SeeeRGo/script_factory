import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeJsonWorkflow, computeWorkflowExpression } from '../src/json-workflow.js';
const template = JSON.parse(await readFile(new URL('../demo/sbis-report-full.json', import.meta.url), 'utf8'));

test('JSON selects bundle parts from primary references, not unrelated newer files, with one flat result', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'sbis-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const incoming=path.join(root,'incoming');await mkdir(incoming);
  await writeFile(path.join(incoming,'MAIN_report.xml'),'<File partA="PART8_linked.xml" partB="PART9_linked.xml"/>');
  for(const name of ['PART8_linked.xml','PART9_linked.xml','PART8_unrelated.xml'])await writeFile(path.join(incoming,name),'<Part/>');
  await utimes(path.join(incoming,'PART8_unrelated.xml'),new Date(),new Date(Date.now()+10000));
  const script=structuredClone(template);const branch=script.steps.find(s=>s.id==='sbis_run_reports');branch.then=branch.then.slice(0,branch.then.findIndex(s=>s.action==='browser_launch'));
  const opts={script,context:{inn:'1234567890',mode:'preflight',root_dir:incoming,authority_prefixes:[{authority:'FNS',prefixes:['MAIN_','PART8_','PART9_'],bundle_files:true}]},allowedRoots:[root],artifactDirectory:path.join(root,'artifacts'),checkIp:async()=>({status:'success',ip:'127.0.0.1'})};
  const result=await executeJsonWorkflow(opts);
  assert.equal(result.context.Rezult_1.file_count,3);
  assert.equal(result.context.Rezult_1.bundle_verified,true);
  assert.equal(result.context.Rezult_1.file_name_2,'PART8_linked.xml');
  assert.equal(result.context.Rezult_1.file_name_3,'PART9_linked.xml');
  assert.equal(result.context.Rezult_2,undefined);
  for(const value of Object.values(result.context.Rezult_1))assert.ok(value===null||['string','number','boolean'].includes(typeof value));
  await rm(path.join(incoming,'PART9_linked.xml'));
  await assert.rejects(executeJsonWorkflow(opts),e=>e.code==='BUNDLE_PART_MISSING');
  await writeFile(path.join(incoming,'MAIN_report.xml'),'<File partA="PART8_linked.xml"/>');
  await assert.rejects(executeJsonWorkflow(opts),e=>e.code==='BUNDLE_REFERENCE_MISSING');
});

async function selectionOptions(t, names, plans, whole = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'sbis-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const incoming = path.join(root, 'incoming'); await mkdir(incoming);
  for (const name of names) await writeFile(path.join(incoming, name), '<Report/>');
  const script = structuredClone(template);
  if (!whole) {
    const branch = script.steps.find(s => s.id === 'sbis_run_reports');
    branch.then = branch.then.slice(0, branch.then.findIndex(s => s.action === 'browser_launch'));
  }
  return { script, context: { inn: '1234567890', mode: 'preflight', root_dir: incoming, authority_prefixes: plans },
    allowedRoots: [root], artifactDirectory: path.join(root, 'artifacts'),
    checkIp: async () => ({ status: 'success', ip: '127.0.0.1' }), root, incoming };
}

test('no matching XML succeeds without results, artifacts, browser or IP calls', async t => {
  for (const names of [[], ['unrelated.xml', 'NO_report.pdf']]) {
    const opts = await selectionOptions(t, names, [
      { authority: 'FNS', prefixes: ['NO_'] }, { authority: 'SFR', prefixes: ['POVD'] }
    ], true);
    opts.context.mode = 'send'; opts.context.submit_enabled = true;
    opts.checkIp = () => { throw Error('IP must not be checked for an empty folder'); };
    const events = []; opts.onEvent = e => events.push(e);
    const result = await executeJsonWorkflow(opts);
    assert.deepEqual(result.context, { artifacts: [] });
    assert.ok(!events.some(e => e.action === 'browser_launch'));
    await assert.rejects(readdir(opts.artifactDirectory), { code: 'ENOENT' });
    assert.deepEqual((await readdir(opts.incoming)).sort(), names.sort());
  }
});

test('missing prefixes and empty authorities are skipped; all matches and overlapping prefixes are deduplicated', async t => {
  const opts = await selectionOptions(t, ['NO_first.xml', 'NO_second.xml', 'unrelated.xml'], [
    { authority: 'FNS', prefixes: ['ABSENT_', 'NO_', 'NO_first'] },
    { authority: 'SFR', prefixes: ['POVD'], ui: { organization_selector: null } }
  ]);
  const result = await executeJsonWorkflow(opts);
  const records = Object.values(result.context).filter(r => r?.file_name);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.file_name).sort(), ['NO_first.xml', 'NO_second.xml']);
  assert.ok(records.every(r => r.authority === 'FNS'));
  opts.context.allow_multiple = false;
  await assert.rejects(executeJsonWorkflow(opts), { code: 'MULTIPLE_FILES' });
});

test('an absent primary bundle is skipped, but a present incomplete bundle still fails', async t => {
  const plans = [{ authority: 'FNS', prefixes: ['MAIN_', 'PART8_', 'PART9_'], bundle_files: true }];
  const opts = await selectionOptions(t, ['PART8_orphan.xml'], plans, true);
  assert.deepEqual((await executeJsonWorkflow(opts)).context, { artifacts: [] });
  await writeFile(path.join(opts.incoming, 'MAIN_report.xml'), '<File part8="PART8_orphan.xml" part9="PART9_missing.xml"/>');
  await assert.rejects(executeJsonWorkflow(opts), { code: 'BUNDLE_PART_MISSING' });
});


test('overlapping prefixes never discard a uniquely matching file, regardless of directory enumeration', async () => {
  const expression = template.steps.find(step => step.id === 'sbis_select_reports').params.expression;
  const permutations = values => values.length ? values.flatMap((value, i) =>
    permutations(values.filter((_, j) => j !== i)).map(rest => [value, ...rest])) : [[]];
  for (const modified of [100, 300]) {
    const files = [
      { filename: 'NO_NDS_one.xml', path: '/incoming/NO_NDS_one.xml', modified_ms: modified },
      { filename: 'NO_OTHER_one.xml', path: '/incoming/NO_OTHER_one.xml', modified_ms: 200 },
      { filename: 'unrelated.xml', path: '/incoming/unrelated.xml', modified_ms: 400 }
    ];
    for (const prefixes of [['NO_', 'NO_NDS_'], ['NO_NDS_', 'NO_']]) {
      let expectedOrder;
      for (const directory_files of permutations(files)) {
        const reports = await computeWorkflowExpression(expression, { directory_files, mode: 'preflight',
          allow_multiple: true, plans: [{ authority: 'FNS', prefixes, ui: {} }] });
        const names = reports.map(report => report.filename);
        assert.deepEqual([...names].sort(), ['NO_NDS_one.xml', 'NO_OTHER_one.xml']);
        expectedOrder ??= names;
        assert.deepEqual(names, expectedOrder, 'Directory enumeration must not change report order');
      }
    }
  }
});
