import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=new Set(['success','failed','validation_failed','timeout','cancelled']);
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t,mode){
 const dir=await mkdtemp(path.join(tmpdir(),'sf-retry-policy-')),port=await freePort(),workerPort=await freePort();
 const account=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${userInfo().username}`:userInfo().username;
 const env={...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,EXECUTION_MODE:mode,WORKER_PORT:String(workerPort),WORKER_ACCOUNT:account,WORKER_AUTH_TOKEN:'test-retry-policy-worker-secret-32-characters',API_KEY:'retry-policy-test',UN_ID:'retry-policy-un',WEB_LOGIN:'test',WEB_PASSWORD:'test',MAX_PARALLEL_JOBS:'1',RETRY_MAX_ATTEMPTS:'2',RETRY_BACKOFF_MS:'1',POWER_ENABLED:'false',POWER_BACKGROUND_ENABLED:'false',BROWSER_HEADLESS:'true',PUPPETEER_EXECUTABLE_PATH:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium'};
 const children=[];let diagnostics='';
 t.after(async()=>{for(const child of children.reverse()){if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}}await rm(dir,{recursive:true,force:true});});
 const start=file=>{const child=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>diagnostics+=b);children.push(child);};
 const request=(route,body)=>fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{'X-API-Key':'retry-policy-test','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 start('src/server.js');if(mode==='broker')start('src/browser-worker.js');
 let ready=false;
 for(let i=0;i<300;i++){try{if((await request('/health')).ok){ready=true;break;}}catch{}await wait(20);}
 assert.ok(ready,diagnostics);
 const job=async id=>(await(await request('/api/v2/jobs/'+id)).json()).job;
 return {dir,request,job,async create(body){const r=await request('/api/v2/jobs',{timeout_ms:10000,...body});assert.equal(r.status,201,await r.clone().text());return (await r.json()).job.job_id;},async finish(id){for(let i=0;i<1000;i++){const j=await job(id);if(terminal.has(j.status))return j;await wait(20);}assert.fail('Job did not finish: '+diagnostics);}};
}
for(const mode of ['inline','broker'])test(`${mode}: caller policy controls all script retries`,async t=>{
 const f=await fixture(t,mode);
 await t.test('workflow business errors consume exactly the supplied budget',async()=>{
  const id=await f.create({retry_policy:{max_attempts:3,backoff_ms:5},script:{format:'json-workflow',steps:[{action:'fail',title:'Business failure',params:{error_code:'REPORTS_FAILED',message:'Отчёт уже загружен'}}],output:{}}});
  const j=await f.finish(id);assert.equal(j.status,'failed');assert.equal(j.attempts,3);assert.equal(j.error.code,'REPORTS_FAILED');assert.equal(Object.hasOwn(j.error,'retryable'),false);
 });
 await t.test('max_attempts=1 disables retries',async()=>{
  const id=await f.create({retry_policy:{max_attempts:1},script:{format:'json-workflow',steps:[{action:'fail',params:{error_code:'ONE_ATTEMPT'}}]}});
  const j=await f.finish(id);assert.equal(j.attempts,1);assert.equal(j.error.code,'ONE_ATTEMPT');
 });
 await t.test('service defaults apply when policy is omitted, including legacy validation errors',async()=>{
  const id=await f.create({script:{steps:[{action:'validate_report',params:{valid:false}}]}});
  const j=await f.finish(id);assert.equal(j.status,'validation_failed');assert.equal(j.attempts,2);assert.equal(Object.hasOwn(j.error,'retryable'),false);
 });
 await t.test('workflow succeeds on the second attempt with isolated artifacts',async()=>{
  const id=await f.create({retry_policy:{max_attempts:3,backoff_ms:5},script:{format:'json-workflow',steps:[
   {action:'artifact_write',params:{filename:'same-name.txt',text:'{{attempt}}'}},
   {action:'compute',params:{expression:'context.attempt===1'},save_as:'first'},
   {action:'if',params:{condition:'{{first}}'},then:[{action:'fail',params:{error_code:'FIRST_ATTEMPT'}}],else:[]},
   {action:'set',params:{answer:{state:'completed',attempt:'{{attempt}}'}}}
  ],output:{Rezult_1:'{{answer}}'}}});
  const j=await f.finish(id);assert.equal(j.status,'success');assert.equal(j.attempts,2);assert.equal(j.result.Rezult_1.attempt,2);
  const root=path.join(f.dir,'artifacts',id);assert.equal(await readFile(path.join(root,'same-name.txt'),'utf8'),'1');assert.equal(await readFile(path.join(root,'attempt-2','same-name.txt'),'utf8'),'2');
  const r=await f.request(j.result.artifacts[0].api_url);assert.equal(await r.text(),'2');
 });
 await t.test('step timeout retries, job timeout stops',async()=>{
  const script={format:'json-workflow',steps:[{action:'wait',params:{duration_ms:100},timeout_ms:10}],output:{}};
  const j=await f.finish(await f.create({retry_policy:{max_attempts:3,backoff_ms:1},script}));assert.equal(j.attempts,3);assert.equal(j.status,'timeout');
  const timed=await f.finish(await f.create({timeout_ms:50,retry_policy:{max_attempts:3,backoff_ms:1},script:{format:'json-workflow',steps:[{action:'wait',params:{duration_ms:1000}}],output:{}}}));
  assert.equal(timed.status,'timeout');assert.equal(timed.attempts,1);
 });
 await t.test('explicit cancellation never dispatches another attempt',async()=>{
  const id=await f.create({retry_policy:{max_attempts:3,backoff_ms:1},script:{format:'json-workflow',steps:[{action:'wait',params:{duration_ms:3000}}],output:{}}});
  for(let i=0;i<200;i++){if((await f.job(id)).status==='running')break;await wait(10);}
  assert.equal((await f.request(`/api/v2/jobs/${id}/cancel`,{})).status,202);const j=await f.finish(id);assert.equal(j.status,'cancelled');assert.equal(j.attempts,1);
 });
 await t.test('native Recorder failures also follow caller policy',async()=>{
  const id=await f.create({retry_policy:{max_attempts:2,backoff_ms:1},script:{title:'Recorder retry',timeout:500,steps:[{type:'navigate',url:'data:text/html,<title>retry</title>'},{type:'waitForExpression',expression:'false',timeout:50}]}});
  const j=await f.finish(id);assert.equal(j.status,'failed');assert.equal(j.attempts,2);assert.equal(Object.hasOwn(j.error,'retryable'),false);
 });
 await t.test('shipped retry, success, missing-file and timeout demos use the workflow executor',async()=>{
  const load=async name=>JSON.parse(await readFile(new URL(`../demo/${name}.json`,import.meta.url),'utf8'));
  const retry=await load('retry');const retried=await f.finish(await f.create(retry));assert.equal(retried.status,'success');assert.equal(retried.attempts,2);assert.equal(retried.result.Rezult_1.attempt,2);
  const incoming=path.join(f.dir,'incoming'),loaded=path.join(f.dir,'loaded'),empty=path.join(f.dir,'empty');await mkdir(incoming);await mkdir(empty);
  for(const name of ['FNS_one.xml','SFR_two.xml'])await writeFile(path.join(incoming,name),'<TEST_ONLY />');
  const success=await load('success');success.context={root_dir:incoming,loaded_dir:loaded};
  const done=await f.finish(await f.create(success));assert.equal(done.status,'success',JSON.stringify(done.error));assert.equal(done.result.Rezult_1.file_count,2);assert.deepEqual((await readdir(loaded)).sort(),['FNS_one.xml','SFR_two.xml']);
  const missing=await load('file-not-found');missing.context={root_dir:empty};const failed=await f.finish(await f.create(missing));assert.equal(failed.status,'failed');assert.equal(failed.error.code,'FILE_NOT_FOUND');
  const timeout=await f.finish(await f.create(await load('timeout')));assert.equal(timeout.status,'timeout');assert.equal(timeout.attempts,1);
 });
 await t.test('shipped file demo downloads all four formats and returns browser proof',async()=>{
  const body=JSON.parse(await readFile(new URL('../demo/download-save-open.json',import.meta.url),'utf8'));delete body.uid;delete body.callback;
  const j=await f.finish(await f.create(body));assert.equal(j.status,'success',JSON.stringify(j.error));
  const files=j.result.artifacts.filter(a=>['.xml','.json','.csv','.txt'].includes(path.extname(a.filename)));
  assert.equal(files.length,4);assert.ok(j.result.artifacts.some(a=>a.filename==='opened-document.png'));
  for(const file of files){const response=await f.request(file.api_url);assert.equal(response.status,200);assert.ok((await response.text()).length>0);}
 });
});
