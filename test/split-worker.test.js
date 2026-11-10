import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'sf-split-')),port=await freePort(),workerPort=await freePort();let api,worker;
 const account=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${userInfo().username}`:userInfo().username;
 const env={...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),EXECUTION_MODE:'broker',WORKER_PORT:String(workerPort),WORKER_AUTH_TOKEN:'test-worker-transport-secret-32-characters',WORKER_ACCOUNT:account,WORKER_STARTUP_MS:'600',WORKER_HEARTBEAT_MS:'100',WORKER_LOST_MS:'1000',WORKER_CANCEL_MS:'1000',API_KEY:'split-secret',UN_ID:'split-test',WEB_LOGIN:'test',WEB_PASSWORD:'test',BROWSER_HEADLESS:'true',POWER_ENABLED:'false',POWER_BACKGROUND_ENABLED:'false',MAX_PARALLEL_JOBS:'1'};
 const origin='http://127.0.0.1:'+port;
 const request=(route,body,headers={})=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'X-API-Key':'split-secret','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const stop=async(p,signal='SIGTERM')=>{if(p&&p.exitCode===null){p.kill(signal);await once(p,'exit');}};
 const startApi=async()=>{api=spawn(process.execPath,['src/server.js'],{env,stdio:['ignore','pipe','pipe']});let out='';api.stdout.on('data',b=>out+=b);api.stderr.on('data',b=>out+=b);for(let i=0;i<200;i++){if(out.includes('script-factory listening'))return;if(api.exitCode!==null)throw new Error(out);await wait(20);}throw new Error(out);};
 const startWorker=async(extra={})=>{worker=spawn(process.execPath,['src/browser-worker.js'],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});let out='';worker.stdout.on('data',b=>out+=b);worker.stderr.on('data',b=>out+=b);for(let i=0;i<200;i++){if(worker.exitCode!==null)throw new Error(out);const h=await(await request('/health')).json();if(h.ready)return;await wait(20);}throw new Error('Worker not ready: '+out);};
 t.after(async()=>{await stop(worker);await stop(api);await rm(dir,{recursive:true,force:true});});await startApi();
 return {dir,env,request,startApi,startWorker,stopApi:()=>stop(api),killApi:()=>stop(api,'SIGKILL'),killWorker:()=>stop(worker,'SIGKILL'),job:async id=>(await(await request('/api/v2/jobs/'+id)).json()).job,
  async terminal(id){for(let i=0;i<300;i++){const j=await this.job(id);if(['success','failed','timeout','cancelled','validation_failed'].includes(j.status))return j;await wait(20);}throw new Error('Job did not finish');}};
}
test('API is alive without login, returns bounded waiting diagnostics and rejects new jobs until worker connects',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/live')).status,200);
 let response=await f.request('/health');assert.equal(response.status,503);let h=await response.json();assert.equal(h.api_available,true);assert.equal(h.ready,false);assert.equal(h.worker.retryable,true);
 assert.equal((await f.request('/api/v2/system/config',undefined,{'X-API-Key':'wrong'})).status,401);
 assert.equal((await f.request('/api/v2/jobs',{script:{steps:[]}})).status,503);
 await wait(650);h=await(await f.request('/health')).json();assert.equal(h.worker.retryable,false);
 await f.startWorker();assert.equal((await f.request('/health')).status,200);
 const created=await(await f.request('/api/v2/jobs',{uid:'split-result',script:{format:'json-workflow',steps:[{action:'artifact_write',params:{filename:'proof.txt',text:'worker account'}}],output:{Rezult_1:{state:'completed'}}}})).json();
 const job=await f.terminal(created.job.job_id);assert.equal(job.status,'success');assert.equal(job.result.Rezult_1.state,'completed');assert.equal(await(await f.request(job.result.artifacts[0].api_url)).text(),'worker account');
});
test('worker loss does not replay an uncertain execution and API continues responding',async t=>{
 const f=await fixture(t);await f.startWorker();
 const created=await(await f.request('/api/v2/jobs',{retry_policy:{max_attempts:3},script:{format:'json-workflow',steps:[{action:'artifact_write',params:{filename:'once.txt',text:'one execution'}},{action:'wait',params:{duration_ms:10000}}],output:{}}})).json();const id=created.job.job_id;
 for(let i=0;i<200;i++){try{await readFile(path.join(f.dir,'artifacts',id,'once.txt'));break;}catch{await wait(10);}}
 await f.killWorker();const job=await f.terminal(id);assert.equal(job.status,'failed');assert.equal(job.error.code,'WORKER_EXECUTION_UNCERTAIN');assert.equal(job.attempts,1);assert.equal((await f.request('/live')).status,200);
 await f.startWorker();assert.equal((await f.job(id)).attempts,1);
});
test('API restart keeps queued work but never automatically resends a running report',async t=>{
 const f=await fixture(t);await f.startWorker();
 const create=script=>f.request('/api/v2/jobs',{script});
 const first=(await(await create({format:'json-workflow',steps:[{action:'wait',params:{duration_ms:10000}}],output:{}})).json()).job;
 const second=(await(await create({format:'json-workflow',steps:[{action:'compute',params:{expression:'({state:"completed"})'},save_as:'answer'}],output:{Rezult_1:'{{answer}}'}})).json()).job;
 assert.equal((await f.job(second.job_id)).status,'queued');await f.killApi();await f.startApi();
 const interrupted=await f.job(first.job_id);assert.equal(interrupted.status,'failed');assert.equal(interrupted.error.code,'WORKER_EXECUTION_UNCERTAIN');assert.equal(interrupted.attempts,1);
 const completed=await f.terminal(second.job_id);assert.equal(completed.status,'success');assert.equal((await f.job(first.job_id)).attempts,1);
});
test('separate worker executes a real Recorder browser flow and returns screenshot artifacts',async t=>{
 const f=await fixture(t);await f.startWorker();
 const response=await f.request('/api/v2/jobs',{script:{title:'Split browser smoke',timeout:10000,steps:[{type:'navigate',url:'data:text/html,<title>Worker smoke</title><button id="proof">Worker ready</button>'},{type:'waitForElement',selectors:[['#proof']],visible:true},{type:'click',selectors:[['#proof']],offsetX:10,offsetY:10}]}});
 assert.equal(response.status,201);const {job}=await response.json();const finished=await f.terminal(job.job_id);assert.equal(finished.status,'success',JSON.stringify(finished.error));assert.ok(finished.result.artifacts.some(a=>a.filename.endsWith('.png')));
});
test('sealed maintenance verifies the separate worker and releases its execution slot',async t=>{
 const f=await fixture(t);await f.startWorker();
 for(const action of ['begin','seal'])assert.equal((await f.request('/api/v2/system/maintenance/'+action,{owner:'split-maintenance'})).status,200);
 const response=await f.request('/api/v2/system/maintenance/verify',{owner:'split-maintenance'});assert.equal(response.status,200);assert.equal((await response.json()).verified,true);
 const status=await(await f.request('/api/v2/system/worker/status')).json();assert.equal(status.active,0);
 assert.equal((await f.request('/api/v2/system/maintenance/end',{owner:'split-maintenance'})).status,200);
 assert.equal((await f.request('/health')).status,200);
});
test('retry acknowledges the failed attempt before the next dispatch, cancellation releases the worker',async t=>{
 const f=await fixture(t);await f.startWorker();
 const first=await(await f.request('/api/v2/jobs',{script:{steps:[],simulate:{outcome:'retry_once',delay_ms:0}},retry_policy:{max_attempts:2,backoff_ms:1}})).json();const retried=await f.terminal(first.job.job_id);assert.equal(retried.status,'success');assert.equal(retried.attempts,2);
 const {job}=await(await f.request('/api/v2/jobs',{script:{format:'json-workflow',steps:[{action:'wait',params:{duration_ms:10000}}],output:{}}})).json();
 for(let i=0;i<100&&(await f.job(job.job_id)).status!=='running';i++)await wait(10);
 assert.equal((await f.request('/api/v2/jobs/'+job.job_id+'/cancel',{})).status,202);assert.equal((await f.terminal(job.job_id)).status,'cancelled');
 for(let i=0;i<100;i++){const status=await(await f.request('/api/v2/system/worker/status')).json();if(status.active===0)return;await wait(10);}assert.fail('Worker slot not released');
});
