import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('real API drains jobs, rejects admission, preserves downloads until seal and stays locked after restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sf-maintenance-api-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let child;const base='http://127.0.0.1:'+port;
 const request=(route,body,method=body===undefined?'GET':'POST',auth=true)=>fetch(base+route,{method,headers:{...(auth?{'X-API-Key':'maintenance-secret'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function start(){child=spawn(process.execPath,['src/server.js'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,API_KEY:'maintenance-secret',WEB_LOGIN:'test',WEB_PASSWORD:'test',UN_ID:'maintenance-test',POWER_ENABLED:'false',POWER_BACKGROUND_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let output='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>output+=b);for(let i=0;i<200;i++){if(output.includes('script-factory listening'))return;if(child.exitCode!==null)throw new Error(output);await wait(20);}throw new Error(output);}
 async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
 t.after(stop);await start();
 assert.equal((await request('/api/v2/system/maintenance',undefined,'GET',false)).status,401);
 const jobBody={script:{format:'json-workflow',steps:[{action:'artifact_write',params:{filename:'ready.txt',text:'ready'}},{action:'wait',params:{duration_ms:500}}],output:{}}};
 const created=await(await request('/api/v2/jobs',jobBody)).json();assert.ok(created.job?.job_id);const id=created.job.job_id;
 assert.equal((await request('/api/v2/system/maintenance/begin',{owner:'fleet-test'})).status,200);
 assert.equal((await request('/api/v2/jobs',jobBody)).status,503);
 const earlySeal=await request('/api/v2/system/maintenance/seal',{owner:'fleet-test'});assert.equal(earlySeal.status,409);
 let job;
 for(let i=0;i<200;i++){job=(await(await request('/api/v2/jobs/'+id)).json()).job;if(job.status==='success')break;await wait(20);}
 assert.equal(job.status,'success');const artifact=job.result.artifacts[0];assert.ok(artifact.api_url);
 assert.equal((await request(artifact.api_url)).status,200);
 assert.equal((await request('/api/v2/system/maintenance/seal',{owner:'fleet-test'})).status,200);
 assert.equal((await request(artifact.api_url)).status,503);
 assert.equal((await request('/api/v2/system/maintenance/end',{owner:'other'})).status,409);
 await stop();await start();
 const healthResponse=await request('/health');assert.equal(healthResponse.status,503);const health=await healthResponse.json();assert.equal(health.maintenance.owner,'fleet-test');assert.equal(health.maintenance.phase,'installing');
 const proof=await(await request('/api/v2/system/maintenance/verify',{owner:'fleet-test'})).json();assert.equal(proof.verified,true);
 assert.equal((await request('/api/v2/system/maintenance/end',{owner:'fleet-test'})).status,200);
 assert.equal((await request('/health')).status,200);assert.equal((await request(artifact.api_url)).status,200);
});
