import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createFleetServer} from '../fleet/server.mjs';
import {openFleetStore} from '../fleet/store.mjs';
import {hash,releaseBytes,validateRelease} from '../fleet/common.mjs';
import {createAgent} from '../fleet/agent.mjs';
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'pem',type:'spki'}),adminToken='test-controller-admin-token-32-characters';
function release(bytes=Buffer.from('PK-test-release')){const manifest={id:'release-one',version:'0.11.1',release_date:'09.11.2026',commit:'a'.repeat(40),sha256:hash(bytes),size_bytes:bytes.length,min_api_version:'0.11.0',node_major:24,database_schema:'unchanged'};return {manifest,signature:sign(null,releaseBytes(manifest),keys.privateKey).toString('base64')};}
async function root(t){const dir=await mkdtemp(path.join(tmpdir(),'sf-fleet-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function listen(t,server){await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return 'http://127.0.0.1:'+server.address().port;}
const beat=id=>({un_id:id,version:'0.11.0',api_ready:true});
test('signed releases reject changed versions, hashes and untrusted signing keys',()=>{
 const envelope=release();assert.equal(validateRelease(envelope,publicKey).version,'0.11.1');
 const changed=structuredClone(envelope);changed.manifest.version='0.10.2';assert.throws(()=>validateRelease(changed,publicKey),{code:'INVALID_SIGNATURE'});
 assert.throws(()=>validateRelease(envelope,generateKeyPairSync('ed25519').publicKey),{code:'INVALID_SIGNATURE'});
});
test('pilot gates batches, errors pause rollout, explicit retry and restart preserve state',async t=>{
 const dir=await root(t),file=path.join(dir,'fleet.sqlite');let s=openFleetStore(file,{maxConcurrent:2});
 for(const id of ['one','two','three'])s.addNode({id,un_id:id});
 s.addRelease(release());s.readyRelease('release-one');
 const r=s.rollout({release_id:'release-one',node_ids:['one','two','three'],batch_size:2,canary_count:2});
 assert.equal(s.heartbeat('three',beat('three')).command,null);
 const a=s.heartbeat('one',beat('one')).command,b=s.heartbeat('two',beat('two')).command;
 s.report('one',a.deployment_id,{status:'succeeded',version:'0.11.1'});assert.equal(s.heartbeat('three',beat('three')).command,null);
 s.report('two',b.deployment_id,{status:'rolled_back',error_code:'HEALTH_FAILED'});
 assert.equal(s.read().rollouts[r.id].status,'paused');assert.equal(s.heartbeat('three',beat('three')).command,null);
 s.close();s=openFleetStore(file,{maxConcurrent:2});t.after(()=>s.close());assert.equal(s.read().rollouts[r.id].status,'paused');
 const retry=s.retry(b.deployment_id);s.control(r.id,'resume');assert.equal(s.heartbeat('two',beat('two')).command.deployment_id,retry.id);
 s.report('two',retry.id,{status:'succeeded',version:'0.11.1'});const c=s.heartbeat('three',beat('three')).command;assert.ok(c);
 s.report('three',c.deployment_id,{status:'succeeded',version:'0.11.1'});assert.equal(s.read().rollouts[r.id].status,'completed');
});
test('global concurrency and idempotent deferred reports do not reassign an uncertain installation',async t=>{
 const s=openFleetStore(path.join(await root(t),'fleet.sqlite'),{maxConcurrent:1});t.after(()=>s.close());
 for(const id of ['one','two'])s.addNode({id,un_id:id});s.addRelease(release());s.readyRelease('release-one');
 for(const id of ['one','two'])s.rollout({release_id:'release-one',node_ids:[id],canary_count:1});
 const a=s.heartbeat('one',beat('one')).command;assert.equal(s.heartbeat('two',beat('two')).command,null);
 const report={status:'deferred',error_code:'DRAIN_TIMEOUT',report_id:randomUUID()};s.report('one',a.deployment_id,report);assert.deepEqual(s.report('one',a.deployment_id,report),{accepted:true});
 assert.equal(s.read().deployments[a.deployment_id].attempts,1);const b=s.heartbeat('two',beat('two')).command;assert.ok(b);
 s.report('two',b.deployment_id,{status:'recovery_required',error_code:'INSTALL_OUTCOME_UNKNOWN'});
 assert.throws(()=>s.rollout({release_id:'release-one',node_ids:['two'],canary_count:1}),{code:'NODE_BUSY'});
 assert.throws(()=>s.resolve(b.deployment_id,{confirm_recovered:true}),{code:'RECOVERY_NOT_CONFIRMED'});
 s.heartbeat('two',{...beat('two'),maintenance:false});assert.deepEqual(s.resolve(b.deployment_id,{confirm_recovered:true}),{resolved:true});
});
test('HTTP enrollment, token revocation and package verification are isolated from admin APIs',async t=>{
 const dir=await root(t),{server,store}=await createFleetServer({dataDir:dir,adminToken,publicKey});const origin=await listen(t,server);
 const admin=(route,body,method='POST')=>fetch(origin+route,{method,headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await fetch(origin+'/api/fleet')).status,401);
 const enrollment=await(await admin('/api/nodes',{id:'one',un_id:'one'})).json();assert.ok(enrollment.token);
 const russian=await admin('/api/nodes',{id:'ru-node',un_id:'УН Нефедов А.А.',group:'Тестовые'});assert.equal(russian.status,201);assert.equal((await russian.json()).node.un_id,'УН Нефедов А.А.');
 const poll=()=>fetch(origin+'/agent/one/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+enrollment.token},body:JSON.stringify(beat('one'))});
 assert.equal((await poll()).status,200);
 assert.equal((await fetch(origin+'/api/fleet',{headers:{Authorization:'Bearer '+enrollment.token}})).status,401);
 assert.equal((await admin('/api/releases',release())).status,201);
 const bytes=Buffer.from('PK-test-release');
 const upload=body=>fetch(origin+'/api/releases/release-one/package',{method:'PUT',headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/zip'},body});
 assert.equal((await upload(Buffer.from('bad'))).status,400);assert.equal(store.read().releases['release-one'].ready,false);
 assert.equal((await upload(bytes)).status,200);assert.equal((await upload(bytes)).status,409);
 const before=await fetch(origin+'/agent/one/packages/release-one',{headers:{Authorization:'Bearer '+enrollment.token}});assert.equal(before.status,403);
 store.rollout({release_id:'release-one',node_ids:['one'],canary_count:1});await poll();
 const packageResponse=await fetch(origin+'/agent/one/packages/release-one',{headers:{Authorization:'Bearer '+enrollment.token}});assert.deepEqual(Buffer.from(await packageResponse.arrayBuffer()),bytes);
 const overview=await(await fetch(origin+'/api/fleet',{headers:{Authorization:'Bearer '+adminToken}})).text();assert.equal(overview.includes(enrollment.token),false);assert.equal(overview.includes('token_hash'),false);
 await admin('/api/nodes/one/revoke',{});assert.equal((await poll()).status,401);
});

for(const scenario of ['success','post_update_smoke_failure','installer_rollback','tampered_download','lost_report_ack','restart_unknown_install','restart_after_success'])test('agent pipeline: '+scenario,async t=>{
 const dir=await root(t),{server,store}=await createFleetServer({dataDir:path.join(dir,'central'),adminToken,publicKey});const central=await listen(t,server);
 const enrollment=store.addNode({id:'one',un_id:'one'});store.addRelease(release());
 const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dir,'central','packages'),{recursive:true});await writeFile(path.join(dir,'central','packages','release-one.zip'),'PK-test-release');store.readyRelease('release-one');
 const rollout=store.rollout({release_id:'release-one',node_ids:['one'],canary_count:1});
 let currentVersion='0.11.0',maintenance={active:false},installs=0,rollbacks=0;
 const localServer=createServer(async(req,res)=>{
  if(req.headers['x-api-key']!=='local-secret'){res.writeHead(401);res.end('{}');return;}
  let body='';for await(const c of req)body+=c;const data=JSON.parse(body||'{}');
  let result={};let status=200;
  if(req.url==='/health'){result={ready:!maintenance.active,un_id:'one',version:currentVersion,maintenance,checks:{database:{status:'ok'},filesystem:{status:'ok'},browser:{status:'ok'}}};if(maintenance.active)status=503;}
  else if(req.url==='/api/v2/system/maintenance')result=maintenance;
  else if(req.url.endsWith('/begin')){maintenance={active:true,owner:data.owner,phase:'draining',ready_to_update:true};result=maintenance;}
  else if(req.url.endsWith('/seal')){assert.equal(data.owner,maintenance.owner);maintenance.phase='installing';result=maintenance;}
  else if(req.url.endsWith('/end')){assert.equal(data.owner,maintenance.owner);maintenance={active:false};result=maintenance;}
  else if(req.url.endsWith('/verify')){if(scenario==='post_update_smoke_failure'&&currentVersion==='0.11.1'){status=500;result={error:{code:'SMOKE_FAILED'}};}else result={verified:true,version:currentVersion,un_id:'one'};}
  else status=404;
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 });
 const local=await listen(t,localServer);const env=path.join(dir,'.env'),key=path.join(dir,'public.pem'),dataDir=path.join(dir,'agent');
 await writeFile(env,'UN_ID=one\nAPI_KEY=local-secret\n');await writeFile(key,publicKey);await mkdir(dataDir);
 const adapter={install:async()=>{installs++;assert.equal(maintenance.phase,'installing');if(scenario==='installer_rollback')return {rolled_back:true};currentVersion='0.11.1';return {updated:true,backup:'backup-one'};},rollback:async()=>{rollbacks++;currentVersion='0.11.0';return {rolled_back:true};},recover:async()=>null};
 if(scenario==='restart_unknown_install'){
  const command=store.heartbeat('one',beat('one')).command;maintenance={active:true,owner:'fleet-'+command.deployment_id,phase:'installing',ready_to_update:true};
  await writeFile(path.join(dataDir,'state.json'),JSON.stringify({active:{command,owner:maintenance.owner,phase:'installing',initial_version:'0.11.0'},reports:[],completed:[]}));
 }
 if(scenario==='restart_after_success'){
  const command=store.heartbeat('one',beat('one')).command;currentVersion='0.11.1';
  await writeFile(path.join(dataDir,'state.json'),JSON.stringify({active:{command,owner:'fleet-'+command.deployment_id,phase:'succeeded',initial_version:'0.11.0'},reports:[{deployment_id:command.deployment_id,report_id:randomUUID(),status:'succeeded',version:'0.11.1'}],completed:[]}));
 }
 let lost=false;
 const fetchImpl=async(url,opts)=>{
  if(scenario==='tampered_download'&&String(url).includes('/packages/'))return new Response('corrupted-package');
  const r=await fetch(url,opts);
  if(scenario==='lost_report_ack'&&!lost&&String(url).includes('/reports/')){lost=true;throw new Error('response lost after server persisted it');}
  return r;
 };
 const agent=await createAgent({central_url:central,api_url:local,node_id:'one',un_id:'one',token:enrollment.token,release_public_key:key,env_file:env,data_dir:dataDir,poll_seconds:5},{adapter,fetchImpl});
 await agent.tick({waitForWork:true});
 if(scenario==='lost_report_ack')await assert.rejects(agent.tick(),/response lost/);
 await agent.tick({waitForWork:true});await agent.settle();
 const d=Object.values(store.read().deployments)[0];
 if(scenario==='restart_unknown_install'){assert.equal(d.status,'recovery_required');assert.equal(installs,0);assert.equal(maintenance.active,true);}
 else if(scenario==='tampered_download'){assert.equal(d.status,'failed');assert.equal(installs,0);assert.equal(maintenance.active,false);}
 else if(scenario==='post_update_smoke_failure'){assert.equal(d.status,'rolled_back');assert.equal(rollbacks,1);assert.equal(currentVersion,'0.11.0');assert.equal(maintenance.active,false);}
 else if(scenario==='installer_rollback'){assert.equal(d.status,'rolled_back');assert.equal(maintenance.active,false);}
 else{assert.equal(d.status,'succeeded');assert.equal(currentVersion,'0.11.1');assert.equal(maintenance.active,false);assert.equal(store.read().rollouts[rollout.id].status,'completed');if(scenario==='restart_after_success')assert.equal(installs,0);}
});

test('300-node rollout keeps pilot and global parallelism limits across a full polling cycle',async t=>{
 const s=openFleetStore(path.join(await root(t),'fleet.sqlite'),{maxConcurrent:10});t.after(()=>s.close());
 const ids=Array.from({length:300},(_,i)=>'node-'+String(i).padStart(3,'0'));
 for(const id of ids)s.addNode({id,un_id:id});s.addRelease(release());s.readyRelease('release-one');
 s.rollout({release_id:'release-one',node_ids:ids,canary_count:3,batch_size:10});
 let started=Date.now();const pilots=ids.map(id=>s.heartbeat(id,beat(id)).command).filter(Boolean);assert.equal(pilots.length,3);
 for(let i=0;i<3;i++)s.report(ids[i],pilots[i].deployment_id,{status:'succeeded',version:'0.11.1'});
 const batch=ids.map(id=>s.heartbeat(id,beat(id)).command).filter(Boolean);assert.equal(batch.length,10);
 for(let i=3;i<13;i++)assert.equal(s.heartbeat(ids[i],beat(ids[i])).command.deployment_id,batch[i-3].deployment_id);
 assert.equal(Object.values(s.read().deployments).filter(d=>d.status==='assigned').length,10);
 t.diagnostic('Two 300-node polling rounds completed in '+(Date.now()-started)+' ms');
});
