import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeJsonWorkflow } from '../src/json-workflow.js';
const template = JSON.parse(await readFile(new URL('../demo/sbis-report-full.json', import.meta.url), 'utf8'));

test('JSON selects bundle parts from primary references, not unrelated newer files, with one flat result', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'sbis-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const incoming=path.join(root,'incoming');await mkdir(incoming);
  await writeFile(path.join(incoming,'MAIN_report.xml'),'<File partA="PART8_linked.xml" partB="PART9_linked.xml"/>');
  for(const name of ['PART8_linked.xml','PART9_linked.xml','PART8_unrelated.xml'])await writeFile(path.join(incoming,name),'<Part/>');
  await utimes(path.join(incoming,'PART8_unrelated.xml'),new Date(),new Date(Date.now()+10000));
  const script=structuredClone(template);script.steps=script.steps.slice(0,script.steps.findIndex(s=>s.action==='browser_launch'));
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
