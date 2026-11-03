import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplayWithTimeouts } from '../src/replay-timeouts.js';
import { validateScript } from '../src/interpreter.js';
import { executeJsonWorkflow } from '../src/json-workflow.js';
const recording=()=>({title:'Long wait',timeout:120000,steps:[{type:'navigate',url:'data:text/html,<title>ready</title>',timeout:90000}]});
test('extended Replay parser preserves independent recording and step timeouts without mutating input',()=>{
 const raw=recording(),copy=structuredClone(raw),r=parseReplayWithTimeouts(raw);assert.equal(r.timeout,120000);assert.equal(r.steps[0].timeout,90000);assert.deepEqual(raw,copy);assert.deepEqual(validateScript({...raw,format:'puppeteer-replay'}),[]);
});
test('extended Replay still validates structure and invalid timeouts',()=>{
 for(const timeout of [0,-1,Infinity,NaN,1.5,'60000',2147483648]){
  assert.throws(()=>parseReplayWithTimeouts({...recording(),timeout}));
  const r=recording();r.steps[0].timeout=timeout;assert.throws(()=>parseReplayWithTimeouts(r));
 }
 assert.throws(()=>parseReplayWithTimeouts({...recording(),steps:[{type:'not-a-step'}]}));
 assert.equal(parseReplayWithTimeouts({...recording(),timeout:30000}).timeout,30000);
});
test('JSON browser_steps can actually wait beyond 30 seconds',async()=>{
 const started=Date.now();
 const r=await executeJsonWorkflow({headless:true,script:{format:'json-workflow',steps:[
 {action:'browser_launch'},
 {action:'browser_steps',timeout_ms:45000,params:{timeout_ms:40000,steps:[{type:'navigate',url:'data:text/html,<script>setTimeout(()=>window.ready=true,31000)</script>',timeout:35000},{type:'waitForExpression',expression:'window.ready===true',timeout:36000}]}},
 {action:'set',params:{finished:true}}],output:{finished:'{{finished}}'}}});
 assert.equal(r.context.finished,true);assert.ok(Date.now()-started>=30000);
});

test('native Replay runner also honors a fallback timeout above 30 seconds',async t=>{
 const {executeBrowserReplay}=await import('../src/browser-replay.js');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const dir=await mkdtemp(path.join(tmpdir(),'replay-timeout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const r=await executeBrowserReplay({headless:true,timeoutMs:45000,artifactDirectory:dir,jobId:'native-long',script:{title:'Native long wait',steps:[{type:'navigate',url:'data:text/html,<title>Native</title><script>setTimeout(()=>window.ready=true,31000)</script>',timeout:35000},{type:'waitForExpression',expression:'window.ready===true'}]}});
 assert.equal(r.steps_executed,2);assert.equal(r.context.page_title,'Native');
});
