import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {parseEnv} from 'node:util';
import {openFleetStore} from '../fleet/store.mjs';
import {createFleetServer} from '../fleet/server.mjs';
import {createAgent} from '../fleet/agent.mjs';
import {applyConfiguration,restoreConfiguration} from '../fleet/config-local.mjs';
import {atomicJson} from '../fleet/common.mjs';
const masterKey=randomBytes(32),keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),adminToken='test-config-admin-32-characters-long';
async function dir(t){const d=await mkdtemp(path.join(tmpdir(),'sf-config-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
async function listen(t,server){await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return 'http://127.0.0.1:'+server.address().port;}
function prepare(s,ids=['one']){
 s.putSecret({id:'api',value:'new-api-secret-not-to-be-in-db'});s.putSecret({id:'web',value:'web-secret-not-to-be-in-db'});s.putSecret({id:'windows',value:'windows-bootstrap-secret-only'});
 s.putProfile({id:'common',name:'Общий профиль',env:{PORT:'33001',MAX_PARALLEL_JOBS:'1',JOB_RETENTION_DAYS:'7',BROWSER_STEP_DELAY_MS:'500'},secret_refs:{API_KEY:'api',WEB_PASSWORD:'web'}});
 for(const id of ids){s.addNode({id,un_id:'un-'+id});s.assignConfiguration(id,{profile_id:'common',env:{},secret_refs:{},bootstrap:{host:'HOST-'+id,worker_account:'HOST-'+id+'\\robot',windows_username:'admin',windows_password_ref:'windows'}});s.heartbeat(id,{un_id:'un-'+id,version:'0.13.0',api_ready:true,agent_version:'2',capabilities:['configuration-v1'],config_facts:{PORT:'33001'}});}
}
function schedule(s,ids=['one']){const nodes=s.previewConfiguration(ids);return s.rollout({kind:'configuration',node_ids:ids,canary_count:1,batch_size:1,expected_versions:Object.fromEntries(nodes.map(n=>[n.node_id,n]))});}
test('vault encrypts secrets and frozen payloads, masks overview and rejects wrong keys after restart',async t=>{
 const root=await dir(t),file=path.join(root,'fleet.sqlite');let s=openFleetStore(file,{masterKey});prepare(s);schedule(s);const c=s.heartbeat('one',{un_id:'un-one',version:'0.13.0',capabilities:['configuration-v1']}).command;
 const overview=JSON.stringify(s.overview());for(const secret of ['new-api-secret-not-to-be-in-db','web-secret-not-to-be-in-db','windows-bootstrap-secret-only'])assert.ok(!overview.includes(secret));
 const payload=s.configurationPayload('one',c.deployment_id);assert.equal(payload.env.API_KEY,'new-api-secret-not-to-be-in-db');assert.ok(!JSON.stringify(payload).includes('windows-bootstrap'));
 const bootstrap=s.bootstrapBundle(['one'])[0];assert.equal(parseEnv(bootstrap.common_env).UN_ID,'un-one');assert.equal(bootstrap.windows_password,'windows-bootstrap-secret-only');
 assert.throws(()=>s.configurationPayload('other',c.deployment_id),{code:'CONFIGURATION_DENIED'});
 s.close();const bytes=await readFile(file);assert.equal(bytes.includes(Buffer.from('new-api-secret-not-to-be-in-db')),false);
 assert.throws(()=>openFleetStore(file,{masterKey:randomBytes(32)}),{code:'VAULT_KEY_MISMATCH'});
 s=openFleetStore(file,{masterKey});assert.equal(s.configurationPayload('one',c.deployment_id).env.API_KEY,payload.env.API_KEY);s.close();
});
test('preview revisions prevent stale application and shared scheduling enforces pilot and busy nodes',async t=>{
 const s=openFleetStore(path.join(await dir(t),'fleet.sqlite'),{masterKey,maxConcurrent:1});t.after(()=>s.close());prepare(s,['one','two']);
 const old=s.previewConfiguration(['one']);s.putSecret({id:'api',expected_revision:1,value:'rotated-api-secret'});
 assert.throws(()=>s.rollout({kind:'configuration',node_ids:['one'],canary_count:1,expected_versions:{one:old[0]}}),{code:'REVISION_CONFLICT'});
 const r=schedule(s,['one','two']);assert.equal(s.heartbeat('two',{un_id:'un-two',version:'0.13.0',capabilities:['configuration-v1']}).command,null);
 const c=s.heartbeat('one',{un_id:'un-one',version:'0.13.0',capabilities:['configuration-v1']}).command;assert.equal(c.kind,'configuration');
 s.putSecret({id:'api',expected_revision:2,value:'rotated-after-snapshot'});assert.equal(s.configurationPayload('one',c.deployment_id).env.API_KEY,'rotated-api-secret');
 assert.throws(()=>schedule(s,['one']),{code:'NODE_BUSY'});
 assert.throws(()=>s.report('one',c.deployment_id,{status:'succeeded',version:'0.13.0',config_version:'wrong'}),{code:'VERSION_MISMATCH'});
 s.report('one',c.deployment_id,{status:'succeeded',version:'0.13.0',config_version:c.config_version});
 const next=s.heartbeat('two',{un_id:'un-two',version:'0.13.0',capabilities:['configuration-v1']}).command;assert.ok(next);s.report('two',next.deployment_id,{status:'rolled_back',error_code:'HEALTH_FAILED'});assert.equal(s.read().rollouts[r.id].status,'paused');
});
test('profile validation rejects plain secrets, reserved changes, unprepared agents and incomplete Basic',async t=>{
 const s=openFleetStore(path.join(await dir(t),'fleet.sqlite'),{masterKey});t.after(()=>s.close());prepare(s);
 assert.throws(()=>s.putProfile({id:'leak',env:{API_KEY:'plaintext'}}),{code:'INVALID_CONFIG_KEY'});
 assert.throws(()=>s.putProfile({id:'leak',env:{NODE_OPTIONS:'--require=evil'}}),{code:'INVALID_CONFIG_KEY'});
 s.assignConfiguration('one',{expected_revision:1,profile_id:'common',env:{PORT:'33002'}});assert.throws(()=>schedule(s),{code:'BOOTSTRAP_REQUIRED'});
 s.assignConfiguration('one',{expected_revision:2,profile_id:'common',env:{},secret_refs:{CALLBACK_AUTH_USERNAME:'api'}});assert.throws(()=>s.previewConfiguration(['one']),{code:'INCOMPLETE_CALLBACK_AUTH'});
 const locked=openFleetStore(path.join(await dir(t),'locked.sqlite'));t.after(()=>locked.close());assert.throws(()=>locked.putSecret({id:'secret',value:'test'}),{code:'CONFIGURATION_LOCKED'});
});
test('HTTP configuration payload is available only to assigned agent and secret reads are not provided',async t=>{
 const {server,store}=await createFleetServer({dataDir:await dir(t),adminToken,publicKey,masterKey});const origin=await listen(t,server);prepare(store);
 const admin=(route,body,method='POST')=>fetch(origin+route,{method,headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await fetch(origin+'/api/config/preview',{method:'POST',body:'{}'})).status,401);
 assert.equal((await admin('/api/config/secrets/api',null,'GET')).status,404);
 assert.equal((await admin('/api/config/bootstrap',{node_ids:['one']})).status,400);
 const exportResponse=await admin('/api/config/bootstrap',{node_ids:['one'],confirm_sensitive_export:true});assert.equal(exportResponse.status,200);assert.equal(exportResponse.headers.get('cache-control'),'no-store');
 const credential=store.credential('one','rotate');schedule(store);const command=store.heartbeat('one',{un_id:'un-one',version:'0.13.0',capabilities:['configuration-v1']}).command;
 const payload=await fetch(origin+'/agent/one/configuration/'+command.deployment_id,{headers:{Authorization:'Bearer '+credential.token}});assert.equal(payload.status,200);assert.equal((await payload.json()).env.API_KEY,'new-api-secret-not-to-be-in-db');
 store.credential('one','revoke');assert.equal((await fetch(origin+'/agent/one/configuration/'+command.deployment_id,{headers:{Authorization:'Bearer '+credential.token}})).status,401);
});
async function localFixture(t){
 const root=await dir(t),data=path.join(root,'data'),envFile=path.join(root,'.env'),backupDir=path.join(root,'backup'),owner='fleet-config-test',projectPath=path.resolve('.');
 await mkdir(path.join(data,'maintenance'),{recursive:true});await mkdir(path.join(data,'power'),{recursive:true});await atomicJson(path.join(data,'maintenance','state.json'),{active:true,owner,phase:'installing'});await writeFile(envFile,'UN_ID=un-one\nAPI_KEY=old-api-key\nPORT=33001\nDATA_DIR="'+data+'"\nMAX_PARALLEL_JOBS=3\nBROWSER_STEP_DELAY_MS=250\n');
 const db=new DatabaseSync(path.join(data,'state.sqlite'));db.exec('CREATE TABLE app_config(id INTEGER PRIMARY KEY,config_json TEXT,updated_at TEXT); CREATE TABLE jobs(id TEXT,body TEXT)');db.prepare('INSERT INTO app_config VALUES(1,?,?)').run(JSON.stringify({max_parallel_jobs:3,job_retention_days:30,default_job_timeout_ms:30000,retry_policy:{max_attempts:2,backoff_ms:500}}),'before');db.exec("INSERT INTO jobs VALUES('preserve','untouched')");db.close();await writeFile(path.join(data,'power','config.json'),JSON.stringify({user_idle_seconds:999,enabled:false}));
 return {root,data,envFile,backupDir,owner,projectPath,unId:'un-one'};
}
test('local apply changes env and persisted overrides together; rollback preserves job records and unrelated settings',async t=>{
 const f=await localFixture(t),before=await readFile(f.envFile,'utf8');
 await applyConfiguration({...f,payload:{un_id:'un-one',config_version:'v1',env:{API_KEY:'new-key',MAX_PARALLEL_JOBS:'1',JOB_RETENTION_DAYS:'7',POWER_USER_IDLE_SECONDS:'1800',BROWSER_STEP_DELAY_MS:'500'}}});
 assert.equal(parseEnv(await readFile(f.envFile,'utf8')).API_KEY,'new-key');let db=new DatabaseSync(path.join(f.data,'state.sqlite'));let cfg=JSON.parse(db.prepare('SELECT config_json FROM app_config').get().config_json);assert.equal(cfg.job_retention_days,7);assert.equal(cfg.max_parallel_jobs,1);assert.equal(db.prepare('SELECT body FROM jobs').get().body,'untouched');db.close();assert.equal(JSON.parse(await readFile(path.join(f.data,'power','config.json'))).user_idle_seconds,1800);
 await restoreConfiguration(f);assert.equal(await readFile(f.envFile,'utf8'),before);db=new DatabaseSync(path.join(f.data,'state.sqlite'));cfg=JSON.parse(db.prepare('SELECT config_json FROM app_config').get().config_json);assert.equal(cfg.max_parallel_jobs,3);db.close();assert.equal(JSON.parse(await readFile(path.join(f.data,'power','config.json'))).user_idle_seconds,999);
 await assert.rejects(applyConfiguration({...f,payload:{un_id:'un-one',env:{DATA_DIR:'elsewhere'}}}),{code:'BOOTSTRAP_REQUIRED'});
});
for(const scenario of ['success','smoke_failure','restart_unknown'])test('agent configuration pipeline: '+scenario,async t=>{
 const f=await localFixture(t);await atomicJson(path.join(f.data,'maintenance','state.json'),{active:false});
 const centralDir=path.join(f.root,'central'),{server,store}=await createFleetServer({dataDir:centralDir,adminToken,publicKey,masterKey});const central=await listen(t,server);prepare(store);const credential=store.credential('one','rotate');
 let installs=0,rollbacks=0;
 const localServer=createServer(async(req,res)=>{
  const env=parseEnv(await readFile(f.envFile,'utf8'));if(req.headers['x-api-key']!==env.API_KEY){res.writeHead(401);res.end('{}');return;}
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body||'{}');let maintenance=JSON.parse(await readFile(path.join(f.data,'maintenance','state.json'),'utf8')),status=200,result={};
  if(req.url==='/health'){result={ready:!maintenance.active,un_id:'un-one',version:'0.13.0',maintenance,checks:{database:{status:'ok'},filesystem:{status:'ok'},browser:{status:'ok'}}};if(maintenance.active)status=503;}
  else if(req.url==='/api/v2/system/maintenance')result={...maintenance,ready_to_update:maintenance.active};
  else if(req.url.endsWith('/begin')){maintenance={active:true,phase:'draining',owner:input.owner};await atomicJson(path.join(f.data,'maintenance','state.json'),maintenance);result={...maintenance,ready_to_update:true};}
  else if(req.url.endsWith('/seal')){assert.equal(maintenance.owner,input.owner);maintenance.phase='installing';await atomicJson(path.join(f.data,'maintenance','state.json'),maintenance);result={...maintenance,ready_to_update:true};}
  else if(req.url.endsWith('/end')){assert.equal(maintenance.owner,input.owner);await atomicJson(path.join(f.data,'maintenance','state.json'),{active:false});result={active:false};}
  else if(req.url.endsWith('/verify')){if(scenario==='smoke_failure'&&env.BROWSER_STEP_DELAY_MS==='500'){status=500;result={error:{code:'SMOKE_FAILED'}};}else result={verified:true,version:'0.13.0',un_id:'un-one'};}
  else status=404;
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 });
 const api=await listen(t,localServer),pub=path.join(f.root,'public.pem');await writeFile(pub,publicKey);
 const config={central_url:central,node_id:'one',un_id:'un-one',token:credential.token,api_url:api,project_path:f.projectPath,env_file:f.envFile,data_dir:path.join(f.root,'agent'),release_public_key:pub,poll_seconds:5};
 const adapter={
  async installConfiguration(p){installs++;const payload=JSON.parse(await readFile(p.file,'utf8'));await applyConfiguration({...f,owner:p.owner,payload});return {updated:true,backup:f.backupDir};},
  async rollbackConfiguration(p){rollbacks++;await restoreConfiguration({...f,owner:p.owner});return {rolled_back:true};},
  async recoverConfiguration(){return null;}
 };
 let agent=await createAgent(config,{adapter,wait:async()=>{}});await agent.tick({waitForWork:true});schedule(store);
 const op=Object.values(store.read().deployments)[0];
 if(scenario==='restart_unknown'){
  await mkdir(config.data_dir,{recursive:true});const command=store.heartbeat('one',{un_id:'un-one',version:'0.13.0',capabilities:['configuration-v1']}).command;
  await atomicJson(path.join(f.data,'maintenance','state.json'),{active:true,phase:'installing',owner:'fleet-'+op.id});
  await atomicJson(path.join(config.data_dir,'state.json'),{active:{command,owner:'fleet-'+op.id,phase:'installing',initial_version:'0.13.0'},reports:[],completed:[]});agent=await createAgent(config,{adapter,wait:async()=>{}});
 }
 await agent.tick({waitForWork:true});await agent.tick();
 const final=store.read().deployments[op.id];assert.equal(final.status,scenario==='success'?'succeeded':scenario==='smoke_failure'?'rolled_back':'recovery_required');assert.equal(installs,scenario==='restart_unknown'?0:1);assert.equal(rollbacks,scenario==='smoke_failure'?1:0);
 if(scenario==='success'){assert.equal(parseEnv(await readFile(f.envFile,'utf8')).API_KEY,'new-api-secret-not-to-be-in-db');assert.equal(store.overview().nodes.one.applied_config_version,op.config_version);}
 const journal=await readFile(path.join(config.data_dir,'state.json'),'utf8');assert.ok(!journal.includes('new-api-secret-not-to-be-in-db'));assert.ok(!journal.includes('windows-bootstrap-secret-only'));
 if(scenario==='restart_unknown')assert.equal(JSON.parse(await readFile(path.join(f.data,'maintenance','state.json'))).active,true);
});
test('node addresses are explicit and operation history keeps the original target even after card edits',async t=>{
 const s=openFleetStore(path.join(await dir(t),'fleet.sqlite'),{masterKey});t.after(()=>s.close());prepare(s);
 s.putNodeMetadata('one',{expected_revision:1,display_name:'Нефедов А.А.',network_address:'192.168.88.247',rdp_address:'185.82.25.17:42389',api_address:'http://185.82.25.17:33003'});schedule(s);
 const operation=Object.values(s.read().deployments)[0];assert.equal(operation.target_address,'192.168.88.247');assert.equal(operation.target_rdp,'185.82.25.17:42389');
 s.putNodeMetadata('one',{expected_revision:2,network_address:'192.168.88.250'});assert.equal(s.read().deployments[operation.id].target_address,'192.168.88.247');assert.equal(s.overview().nodes.one.network_address,'192.168.88.250');
 assert.throws(()=>s.putNodeMetadata('one',{expected_revision:1,network_address:'old'}),{code:'REVISION_CONFLICT'});
});
test('bulk profile assignment preserves individual overrides and bootstrap credentials inherit safely',async t=>{
 const s=openFleetStore(path.join(await dir(t),'fleet.sqlite'),{masterKey});t.after(()=>s.close());prepare(s,['one','two']);
 s.putProfile({id:'other',env:{MAX_PARALLEL_JOBS:'2'},secret_refs:{API_KEY:'api',WEB_PASSWORD:'web'},bootstrap:{project_path:'C:/script_factory',windows_username:'DEPLOY',windows_password_ref:'windows'}});
 s.assignConfiguration('one',{expected_revision:1,profile_id:'common',env:{JOB_RETENTION_DAYS:'14'},secret_refs:{},bootstrap:{host:'host-one'}});
 assert.throws(()=>s.assignProfile({profile_id:'other',node_ids:['one','two'],expected_revisions:{one:1,two:1}}),{code:'REVISION_CONFLICT'});assert.equal(s.read().nodes.two.configuration.profile_id,'common');
 assert.equal(s.assignProfile({profile_id:'other',node_ids:['one','two'],expected_revisions:{one:2,two:1}}).assigned,2);
 assert.equal(s.previewConfiguration(['one'])[0].env.JOB_RETENTION_DAYS,'14');const bundle=s.bootstrapBundle(['one'])[0];assert.equal(bundle.windows_username,'DEPLOY');assert.equal(bundle.windows_password,'windows-bootstrap-secret-only');assert.equal(bundle.host,'host-one');
 schedule(s,['one']);s.addRelease({manifest:{id:'next',version:'0.14.0'}});s.readyRelease('next');assert.throws(()=>s.rollout({release_id:'next',node_ids:['one'],canary_count:1}),{code:'NODE_BUSY'});
});
test('bootstrap CLI protects exported files and refuses to replace the encryption master key',async t=>{
 const root=await dir(t),{promisify}=await import('node:util'),{execFile}=await import('node:child_process'),{stat}=await import('node:fs/promises');const run=promisify(execFile),tool=path.resolve('scripts/fleet-config.mjs'),keyFile=path.join(root,'keys','fleet-master.key');
 await run(process.execPath,[tool,'keygen','--out',keyFile]);const original=await readFile(keyFile);assert.equal(original.length,32);await assert.rejects(run(process.execPath,[tool,'keygen','--out',keyFile]));assert.deepEqual(await readFile(keyFile),original);
 const {server,store}=await createFleetServer({dataDir:path.join(root,'central'),adminToken,publicKey,masterKey});const origin=await listen(t,server);prepare(store);
 const out=path.join(root,'export');const result=await run(process.execPath,[tool,'bootstrap','--url',origin,'--nodes','one','--out',out],{env:{...process.env,FLEET_ADMIN_TOKEN:adminToken}});
 assert.ok(!result.stdout.includes('new-api-secret-not-to-be-in-db'));const bundle=JSON.parse(await readFile(path.join(out,'fleet-bootstrap.json'),'utf8'));assert.equal(bundle.nodes[0].un_id,'un-one');assert.ok((await readFile(path.join(out,'one.env'),'utf8')).includes('new-api-secret-not-to-be-in-db'));
 if(process.platform!=='win32'){assert.equal((await stat(out)).mode&0o777,0o700);assert.equal((await stat(path.join(out,'fleet-bootstrap.json'))).mode&0o777,0o600);}
});
test('300-node configuration polling does not load encrypted payloads into the overview and completes the pilot gate',async t=>{
 const root=await dir(t),s=openFleetStore(path.join(root,'fleet.sqlite'),{masterKey,maxConcurrent:10});t.after(()=>s.close());
 const ids=Array.from({length:300},(_,i)=>'node-'+String(i).padStart(3,'0'));prepare(s,ids);const start=Date.now();const r=schedule(s,ids);
 for(const id of ids){const cmd=s.heartbeat(id,{un_id:'un-'+id,version:'0.13.0',capabilities:['configuration-v1']}).command;assert.ok(cmd);s.report(id,cmd.deployment_id,{status:'succeeded',version:'0.13.0',config_version:cmd.config_version});}
 assert.equal(s.overview().rollouts[r.id].status,'completed');assert.ok(!JSON.stringify(s.overview()).includes('config_encrypted'));t.diagnostic('300 configuration assignments and acknowledgments: '+(Date.now()-start)+' ms');
});
