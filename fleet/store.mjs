import { DatabaseSync } from 'node:sqlite';
import { randomBytes,randomUUID } from 'node:crypto';
import {validateLayer,validateBootstrap,validateNodeMetadata,vault,resolvedConfiguration,maskedConfiguration,bootstrapKeys,encodeEnv} from './configuration.mjs';
import { fault,hash,identifier,textIdentity,version,compareVersion } from './common.mjs';
const terminal=new Set(['succeeded','rolled_back','failed','recovery_required']);
const active=new Set(['assigned','draining','downloading','installing','verifying']);
const stages=new Set([...active,...terminal,'deferred']);
const now=()=>new Date().toISOString();
export function openFleetStore(file,{maxConcurrent=10,masterKey=null}={}){
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
 const tables=['nodes','releases','rollouts','deployments','profiles','secrets'];
 const secure=masterKey?vault(masterKey):null;
 db.exec('CREATE TABLE IF NOT EXISTS configuration_payloads(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 const getPayload=db.prepare('SELECT body FROM configuration_payloads WHERE id=?'),putPayload=db.prepare('INSERT INTO configuration_payloads(id,body) VALUES(?,?)');
 const encryptedPayload=d=>{const row=getPayload.get(d.id);return row?JSON.parse(row.body):d.config_encrypted;};
 db.exec('CREATE TABLE IF NOT EXISTS vault_meta(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL)');
 const stored=db.prepare('SELECT fingerprint FROM vault_meta WHERE id=1').get();
 if(secure&&stored&&stored.fingerprint!==secure.fingerprint){db.close();throw fault('VAULT_KEY_MISMATCH','Restore the matching master key',503);}
 if(secure&&!stored)db.prepare('INSERT INTO vault_meta VALUES(1,?)').run(secure.fingerprint);
 const unlocked=()=>{if(!secure)throw fault('CONFIGURATION_LOCKED','Set FLEET_MASTER_KEY_FILE to enable configuration management',503);return secure;};
 for(const table of tables)db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
 db.exec('CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL)');
 const select=Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT id,body FROM ${t}`)]));
 const upsert=Object.fromEntries(tables.map(t=>[t,db.prepare(`INSERT INTO ${t}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)]));
 const recent=db.prepare('SELECT body FROM events ORDER BY seq DESC LIMIT 200');
 const insertEvent=db.prepare('INSERT OR IGNORE INTO events(id,body) VALUES(?,?)');
 const selectNode=db.prepare('SELECT body FROM nodes WHERE id=?');
 const own=(o,id)=>Object.hasOwn(o,id)?o[id]:null;
 const read=()=>({...Object.fromEntries(tables.map(t=>[t,Object.fromEntries(select[t].all().map(r=>[r.id,JSON.parse(r.body)]))])),events:recent.all().reverse().map(r=>JSON.parse(r.body))});
 const event=(s,type,details)=>{s.events.push({id:randomUUID(),at:now(),type,...details});};
 function mutate(fn){
  db.exec('BEGIN IMMEDIATE');
  try{
   const s=read(),before=Object.fromEntries(tables.map(t=>[t,new Map(Object.entries(s[t]).map(([id,v])=>[id,JSON.stringify(v)]))])),eventIds=new Set(s.events.map(e=>e.id));
   const r=fn(s);
   // Heartbeats update only the changed node row, not a multi-megabyte fleet snapshot.
   for(const table of tables)for(const [id,value] of Object.entries(s[table])){const encoded=JSON.stringify(value);if(before[table].get(id)!==encoded)upsert[table].run(id,encoded);}
   let eventsAdded=false;for(const e of s.events)if(!eventIds.has(e.id)){insertEvent.run(e.id,JSON.stringify(e));eventsAdded=true;}
   if(eventsAdded)db.exec('DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq),0)-10000 FROM events)');
   db.exec('COMMIT');return r;
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function pauseFailed(s,r,reason){r.status='paused';r.pause_reason=reason;event(s,'rollout_paused',{rollout_id:r.id,reason});}
 function refresh(s,r){
  const ds=Object.values(s.deployments).filter(d=>d.rollout_id===r.id&&d.status!=='superseded');
  if(r.status==='cancelled')return;
  if(ds.every(d=>d.status==='succeeded')){r.status='completed';r.completed_at??=now();return;}
  if(r.status!=='running')return;
  if(Date.now()>Date.parse(r.end_at)){pauseFailed(s,r,'WINDOW_EXPIRED');return;}
  if(ds.some(d=>['failed','rolled_back','recovery_required'].includes(d.status))){pauseFailed(s,r,'DEPLOYMENT_FAILED');return;}
  if(ds.some(d=>active.has(d.status)&&Date.now()-Date.parse(s.nodes[d.node_id].last_seen||d.assigned_at)>r.offline_timeout_seconds*1000)){pauseFailed(s,r,'AGENT_UNRESPONSIVE');}
 }
 return {
  close:()=>db.close(), read,
  overview:()=>mutate(s=>{for(const r of Object.values(s.rollouts))refresh(s,r);return {...s,configuration_enabled:!!secure,secrets:Object.fromEntries(Object.entries(s.secrets).map(([id,{encrypted,...m}])=>[id,m])),deployments:Object.fromEntries(Object.entries(s.deployments).map(([id,{config_encrypted,...d}])=>[id,d])),nodes:Object.fromEntries(Object.entries(s.nodes).map(([id,{token_hash,...n}])=>[id,n]))};}),
  node(id){const row=selectNode.get(id),n=row?JSON.parse(row.body):null;return n&&!n.revoked?n:null;},
  addNode(input){return mutate(s=>{const {id,un_id,group='default'}=input;const metadata=validateNodeMetadata(Object.fromEntries(['display_name','network_address','rdp_address','api_address'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])));if(!identifier(id)||!textIdentity(un_id)||!textIdentity(group)||own(s.nodes,id)||Object.values(s.nodes).some(n=>n.un_id===un_id))throw fault('INVALID_NODE','Unique node id, UN_ID and group required');const token=randomBytes(32).toString('base64url');s.nodes[id]={id,un_id,group,...metadata,metadata_revision:1,token_hash:hash(token),created_at:now(),revoked:false};event(s,'node_created',{node_id:id});return {node:{id,un_id,group,...metadata},token};});},
  putNodeMetadata(id,input){return mutate(s=>{const n=own(s.nodes,id);if(!n)throw fault('NOT_FOUND','Node not found',404);const m=validateNodeMetadata(input);if(input.expected_revision!==(n.metadata_revision||0))throw fault('REVISION_CONFLICT','Reload node addresses before saving',409);Object.assign(n,m);n.metadata_revision=(n.metadata_revision||0)+1;event(s,'node_metadata_saved',{node_id:id,network_address:n.network_address||null});return {id,un_id:n.un_id,...m,metadata_revision:n.metadata_revision};});},
  credential(id,action){return mutate(s=>{const n=Object.hasOwn(s.nodes,id)?s.nodes[id]:null;if(!n)throw fault('NOT_FOUND','Node not found',404);if(action==='revoke'){n.revoked=true;event(s,'node_revoked',{node_id:id});return {revoked:true};}const token=randomBytes(32).toString('base64url');n.token_hash=hash(token);n.revoked=false;event(s,'node_token_rotated',{node_id:id});return {token};});},
  addRelease(envelope){return mutate(s=>{const m=envelope.manifest;if(s.releases[m.id])throw fault('RELEASE_EXISTS','Release ids are immutable',409);s.releases[m.id]={...envelope,ready:false,created_at:now()};event(s,'release_registered',{release_id:m.id});return s.releases[m.id];});},
  readyRelease(id){return mutate(s=>{const r=s.releases[id];if(!r)throw fault('NOT_FOUND','Release not found',404);r.ready=true;event(s,'release_ready',{release_id:id});return {ready:true};});},
  rollout(input){return mutate(s=>{
   const isConfig=input.kind==='configuration';
   const {release_id,node_ids,batch_size=10,canary_count=2,drain_timeout_seconds=1800,offline_timeout_seconds=180,start_at=now(),end_at=new Date(Date.now()+86400000).toISOString()}=input;
   if((!isConfig&&!s.releases[release_id]?.ready)||!Array.isArray(node_ids)||!node_ids.length||node_ids.length>1000||new Set(node_ids).size!==node_ids.length||node_ids.some(id=>!s.nodes[id]||s.nodes[id].revoked)||!Number.isInteger(batch_size)||batch_size<1||batch_size>50||!Number.isInteger(canary_count)||canary_count<1||canary_count>node_ids.length||!Number.isInteger(drain_timeout_seconds)||drain_timeout_seconds<5||drain_timeout_seconds>86400||!Number.isInteger(offline_timeout_seconds)||offline_timeout_seconds<60||offline_timeout_seconds>86400||!Number.isFinite(Date.parse(start_at))||!Number.isFinite(Date.parse(end_at))||Date.parse(end_at)<=Math.max(Date.parse(start_at),Date.now()))throw fault('INVALID_ROLLOUT','Invalid targets, ready release, batch, pilot or window');
   if(Object.values(s.deployments).some(d=>node_ids.includes(d.node_id)&&(active.has(d.status)||d.status==='queued'||d.status==='recovery_required')))throw fault('NODE_BUSY','A target already has an unfinished deployment',409);
   const prepared={};
   if(isConfig){const v=unlocked();for(const id of node_ids){const n=s.nodes[id];if(!n.config_capable||!n.version||compareVersion(n.version,'0.13.0')<0)throw fault('UPGRADE_AGENT_REQUIRED','Update API and agent before configuration deployment',409);const r=resolvedConfiguration(s,n,v);const expected=input.expected_versions?.[id];if(!expected)throw fault('PREVIEW_REQUIRED','Preview selected node settings before applying',409);if(expected.profile_revision!==r.profile_revision||expected.assignment_revision!==r.assignment_revision||Object.keys({...expected.secret_revisions,...r.secret_revisions}).some(k=>expected.secret_revisions?.[k]!==r.secret_revisions[k]))throw fault('REVISION_CONFLICT','Settings changed after preview; preview again',409);if(!Object.keys(r.env).length)throw fault('EMPTY_CONFIGURATION','Assign a nonempty configuration first');for(const k of Object.keys(r.env))if(bootstrapKeys.has(k)){if(r.env[k]!==n.config_facts?.[k])throw fault('BOOTSTRAP_REQUIRED','Network, account or data-path changes require initial provisioning',409);delete r.env[k];}if(!Object.keys(r.env).length)throw fault('EMPTY_CONFIGURATION','No mutable configuration keys remain');prepared[id]=r;}}
   const id=randomUUID();s.rollouts[id]={id,kind:isConfig?'configuration':'release',release_id,node_ids,batch_size,canary_ids:node_ids.slice(0,canary_count),drain_timeout_seconds,offline_timeout_seconds,start_at,end_at,status:'running',created_at:now()};
   for(const node_id of node_ids){const id2=randomUUID();s.deployments[id2]={id:id2,rollout_id:id,node_id,release_id,kind:isConfig?'configuration':'release',target_un_id:s.nodes[node_id].un_id,target_label:s.nodes[node_id].display_name||s.nodes[node_id].un_id,target_address:s.nodes[node_id].network_address||s.nodes[node_id].configuration?.bootstrap?.host||null,target_rdp:s.nodes[node_id].rdp_address||null,target_api:s.nodes[node_id].api_address||null,status:'queued',attempts:0,...(isConfig?{config_version:randomUUID(),target_version:s.nodes[node_id].version,config_keys:Object.keys(prepared[node_id].env)}:{})};if(isConfig)putPayload.run(id2,JSON.stringify(unlocked().seal(prepared[node_id],'deployment:'+id2)));}
   event(s,'rollout_created',{rollout_id:id,release_id});return s.rollouts[id];
  });},
  control(id,action){return mutate(s=>{const r=own(s.rollouts,id);if(!r||['completed','cancelled'].includes(r.status))throw fault('INVALID_ROLLOUT','Rollout not found or already final',409);if(action==='resume'&&Object.values(s.deployments).some(d=>d.rollout_id===id&&['failed','rolled_back','recovery_required'].includes(d.status)))throw fault('RETRY_REQUIRED','Failed nodes require explicit retry or recovery first',409);r.status=action==='pause'?'paused':action==='cancel'?'cancelled':'running';if(action==='cancel')for(const d of Object.values(s.deployments))if(d.rollout_id===id&&d.status==='queued')d.status='cancelled';r.pause_reason=action==='pause'?'ADMIN_PAUSED':null;event(s,'rollout_'+action,{rollout_id:id});return r;});},
  retry(id){return mutate(s=>{const d=s.deployments[id];if(!d||!['failed','rolled_back'].includes(d.status))throw fault('INVALID_RETRY','Only failed or rolled-back deployments may be retried',409);const n={...d,id:randomUUID(),status:'queued',attempts:0};if(d.kind==='configuration')putPayload.run(n.id,JSON.stringify(unlocked().seal(unlocked().open(encryptedPayload(d),'deployment:'+d.id),'deployment:'+n.id)));delete n.assigned_at;delete n.error_code;s.deployments[n.id]=n;d.status='superseded';event(s,'deployment_retried',{deployment_id:id,replacement:n.id});return n;});},
  resolve(id,input){return mutate(s=>{const d=s.deployments[id],n=d&&s.nodes[d.node_id];if(!d||d.status!=='recovery_required'||input.confirm_recovered!==true||!n.api_ready||n.maintenance||!n.last_seen||n.heartbeat_serial<=d.recovery_serial||Date.now()-Date.parse(n.last_seen)>180000)throw fault('RECOVERY_NOT_CONFIRMED','Requires manual recovery and a fresh healthy agent heartbeat',409);d.status='failed';d.error_code='RECOVERY_CONFIRMED';event(s,'recovery_confirmed',{deployment_id:id,node_id:d.node_id});return {resolved:true};});},
  heartbeat(id,input){return mutate(s=>{
   const n=s.nodes[id];if(!n||n.revoked)throw fault('UNAUTHORIZED','Agent credential revoked',401);
   if(input.un_id!==n.un_id)throw fault('UN_ID_MISMATCH','Configured UN_ID does not match registration',409);
   n.last_seen=now();n.heartbeat_serial=(n.heartbeat_serial||0)+1;n.version=version(input.version)?input.version:n.version||null;n.api_ready=input.api_ready===true;n.maintenance=input.maintenance===true;n.agent_version=input.agent_version==='2'?'2':'1';n.config_capable=input.capabilities?.includes('configuration-v1')===true;n.observed_host=typeof input.observed_host==='string'?input.observed_host.slice(0,200):n.observed_host||null;n.observed_addresses=Array.isArray(input.observed_addresses)?input.observed_addresses.filter(x=>typeof x==='string'&&/^[0-9a-fA-F:.]{1,80}$/.test(x)).slice(0,20):n.observed_addresses||[];n.config_facts={};for(const k of ['PORT','HOST','DATA_DIR'])if(typeof input.config_facts?.[k]==='string'&&input.config_facts[k].length<=512)n.config_facts[k]=input.config_facts[k];
   for(const r of Object.values(s.rollouts))refresh(s,r);
   let d=Object.values(s.deployments).find(d=>d.node_id===id&&active.has(d.status));
   if(!d&&Object.values(s.deployments).filter(d=>active.has(d.status)||d.status==='recovery_required').length<maxConcurrent)for(const r of Object.values(s.rollouts)){
    if(r.status!=='running'||Date.now()<Date.parse(r.start_at)||Date.now()>Date.parse(r.end_at))continue;
    const ds=Object.values(s.deployments).filter(d=>d.rollout_id===r.id&&d.status!=='superseded');
    const pilotDone=r.canary_ids.every(id=>ds.some(d=>d.node_id===id&&d.status==='succeeded'));
    if(!pilotDone&&!r.canary_ids.includes(id))continue;
    if(ds.filter(d=>active.has(d.status)).length>=r.batch_size)continue;
    const next=ds.find(d=>d.node_id===id&&d.status==='queued'&&(d.kind!=='configuration'||n.config_capable)&&(!d.retry_at||Date.parse(d.retry_at)<=Date.now()));
    if(next){d=next;d.status='assigned';d.assigned_at=now();d.attempts++;event(s,'deployment_assigned',{deployment_id:d.id,node_id:id});break;}
   }
   return {command:d&&(d.kind!=='configuration'||n.config_capable)?{deployment_id:d.id,...(d.kind==='configuration'?{kind:'configuration',config_version:d.config_version,target_version:d.target_version}:{release:s.releases[d.release_id]}),drain_timeout_seconds:s.rollouts[d.rollout_id].drain_timeout_seconds,deadline_at:s.rollouts[d.rollout_id].end_at}:null};
  });},
  report(id,deployment_id,input){return mutate(s=>{
   const d=s.deployments[deployment_id];if(!d||d.node_id!==id)throw fault('NOT_FOUND','Deployment not found',404);
   if(input.report_id&&(d.report_ids||[]).includes(input.report_id))return {accepted:true};
   if(!stages.has(input.status))throw fault('INVALID_REPORT','Invalid deployment state');
   if(terminal.has(d.status)||d.status==='superseded'){if(d.status===input.status)return {accepted:true};throw fault('DEPLOYMENT_FINISHED','Deployment is already final',409);}
   if(d.status==='queued')throw fault('DEPLOYMENT_NOT_ASSIGNED','No assigned command',409);
   if(input.report_id&&!identifier(input.report_id))throw fault('INVALID_REPORT','Invalid report id');
   if(typeof input.error_code==='string'&&!/^[A-Z0-9_]{1,100}$/.test(input.error_code))throw fault('INVALID_REPORT','Only a technical error code may be reported');
   if(input.status==='succeeded'&&(input.version!==(d.kind==='configuration'?d.target_version:s.releases[d.release_id].manifest.version)||d.kind==='configuration'&&input.config_version!==d.config_version))throw fault('VERSION_MISMATCH','Success requires the exact target version',409);
   d.status=input.status;d.updated_at=now();d.error_code=input.error_code||null;
   if(input.status==='recovery_required'){d.recovery_serial=s.nodes[id].heartbeat_serial||0;s.nodes[id].api_ready=false;}
   if(input.report_id)d.report_ids=[...(d.report_ids||[]),input.report_id].slice(-30);
   if(input.status==='deferred'){d.status=d.attempts>=3?'failed':'queued';d.retry_at=new Date(Date.now()+60000).toISOString();}
   if(version(input.version))s.nodes[id].version=input.version;
   if(input.status==='succeeded'&&d.kind==='configuration')s.nodes[id].applied_config_version=d.config_version;
   event(s,'deployment_report',{deployment_id,node_id:id,status:d.status,error_code:d.error_code});refresh(s,s.rollouts[d.rollout_id]);return {accepted:true};
  });},

  putSecret(input){return mutate(s=>{const v=unlocked();if(!identifier(input.id)||typeof input.value!=='string'||!input.value.length||input.value.length>16384||/[\x00-\x1f\x7f]/.test(input.value)||Object.keys(input).some(k=>!['id','value','expected_revision'].includes(k)))throw fault('INVALID_SECRET','Expected id and a nonempty single-line value');const old=s.secrets[input.id];if(old&&input.expected_revision!==old.revision)throw fault('REVISION_CONFLICT','Reload the secret metadata before replacing it',409);const m={id:input.id,revision:(old?.revision||0)+1,updated_at:now()};s.secrets[input.id]={...m,encrypted:v.seal({value:input.value},'secret:'+input.id)};event(s,'secret_saved',{secret_id:input.id,revision:m.revision});return m;});},
  putProfile(input){return mutate(s=>{unlocked();if(!identifier(input.id))throw fault('INVALID_PROFILE','Profile id required');const layer=validateLayer(input),old=s.profiles[input.id];if(old&&old.revision!==input.expected_revision)throw fault('REVISION_CONFLICT','Reload the profile before saving',409);for(const ref of Object.values(layer.secret_refs))if(ref!==null&&!s.secrets[ref])throw fault('SECRET_NOT_FOUND','Secret reference not found',409);const bootstrap=validateBootstrap(input.bootstrap||{});if(bootstrap.windows_password_ref&&!s.secrets[bootstrap.windows_password_ref])throw fault('SECRET_NOT_FOUND','Windows credential reference not found',409);const p={id:input.id,name:input.name||input.id,...layer,bootstrap,revision:(old?.revision||0)+1,updated_at:now()};s.profiles[p.id]=p;event(s,'profile_saved',{profile_id:p.id,revision:p.revision});return p;});},
  assignConfiguration(id,input){return mutate(s=>{unlocked();const n=own(s.nodes,id);if(!n||n.revoked)throw fault('NOT_FOUND','Node not found',404);const layer=validateLayer(input),old=n.configuration;if(old&&old.revision!==input.expected_revision)throw fault('REVISION_CONFLICT','Reload the node before saving',409);if(input.profile_id&&(!identifier(input.profile_id)||!Object.hasOwn(s.profiles,input.profile_id)))throw fault('PROFILE_NOT_FOUND','Profile not found',409);for(const ref of Object.values(layer.secret_refs))if(ref!==null&&!s.secrets[ref])throw fault('SECRET_NOT_FOUND','Secret reference not found',409);const bootstrap=validateBootstrap(input.bootstrap||{});if(bootstrap.windows_password_ref&&!s.secrets[bootstrap.windows_password_ref])throw fault('SECRET_NOT_FOUND','Windows credential reference not found',409);n.configuration={profile_id:input.profile_id||null,...layer,bootstrap,revision:(old?.revision||0)+1,updated_at:now()};event(s,'node_configuration_saved',{node_id:id,revision:n.configuration.revision});return n.configuration;});},
  assignProfile(input){return mutate(s=>{unlocked();if(!identifier(input.profile_id)||!Object.hasOwn(s.profiles,input.profile_id)||!Array.isArray(input.node_ids)||!input.node_ids.length||input.node_ids.length>1000||new Set(input.node_ids).size!==input.node_ids.length)throw fault('INVALID_PROFILE_ASSIGNMENT','Select a profile and distinct nodes');for(const id of input.node_ids){const n=own(s.nodes,id);if(!n||n.revoked)throw fault('NOT_FOUND','Node not found',404);if(input.expected_revisions?.[id]!==(n.configuration?.revision||0))throw fault('REVISION_CONFLICT','Reload node settings before bulk assignment',409);n.configuration={env:{},secret_refs:{},bootstrap:{},...n.configuration,profile_id:input.profile_id,revision:(n.configuration?.revision||0)+1,updated_at:now()};}event(s,'profile_assigned',{profile_id:input.profile_id,node_ids:input.node_ids});return {assigned:input.node_ids.length};});},
  previewConfiguration(ids){const v=unlocked(),s=read();if(!Array.isArray(ids)||!ids.length||ids.length>1000)throw fault('INVALID_NODES','Select nodes');return ids.map(id=>{const n=own(s.nodes,id);if(!n||n.revoked)throw fault('NOT_FOUND','Node not found',404);const r=maskedConfiguration(s,n,v);return {node_id:id,un_id:n.un_id,...r,bootstrap:{...s.profiles[n.configuration?.profile_id]?.bootstrap,...n.configuration?.bootstrap},requires_agent_upgrade:!n.config_capable};});},
  configurationPayload(id,deploymentId){const v=unlocked(),s=read(),d=own(s.deployments,deploymentId);if(!d||d.kind!=='configuration'||d.node_id!==id||!active.has(d.status))throw fault('CONFIGURATION_DENIED','No active configuration assignment',403);return {...v.open(encryptedPayload(d),'deployment:'+d.id),un_id:s.nodes[id].un_id,config_version:d.config_version};},
  bootstrapBundle(ids){return mutate(s=>{const v=unlocked();if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length)throw fault('INVALID_NODES','Select distinct nodes');const result=ids.map(id=>{const n=own(s.nodes,id);if(!n||n.revoked)throw fault('NOT_FOUND','Node not found',404);const r=resolvedConfiguration(s,n,v),env={HOST:'0.0.0.0',PORT:'33001',MAX_PARALLEL_JOBS:'1',POWER_ENABLED:'false',POWER_BACKGROUND_ENABLED:'false',...r.env,UN_ID:n.un_id,EXECUTION_MODE:'inline',WORKER_ACCOUNT:'',WORKER_AUTH_TOKEN:'',WORKER_PORT:''};if(!env.API_KEY||!env.WEB_PASSWORD)throw fault('BOOTSTRAP_SECRETS_REQUIRED','Assign API_KEY and WEB_PASSWORD secrets before exporting',409);const b={...s.profiles[n.configuration?.profile_id]?.bootstrap,...n.configuration?.bootstrap};return {node_id:id,un_id:n.un_id,network_address:n.network_address||null,rdp_address:n.rdp_address||null,api_address:n.api_address||null,...b,host:b.host||n.network_address||null,project_path:b.project_path||'C:/script_factory',env_file:b.env_file||((b.project_path||'C:/script_factory')+'/.env'),windows_password:b.windows_password_ref?v.open(s.secrets[b.windows_password_ref].encrypted,'secret:'+b.windows_password_ref).value:null,common_env:encodeEnv(env)};});event(s,'bootstrap_exported',{node_ids:ids});return result;});},
  mayDownload(id,release_id){return Object.values(read().deployments).some(d=>d.node_id===id&&d.release_id===release_id&&active.has(d.status));}
 };
}
