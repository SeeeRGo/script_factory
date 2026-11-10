import { mkdir,readFile,unlink } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson,optionalJson,serviceUrl,validateRelease,compareVersion,identifier,textIdentity,fault } from './common.mjs';
import { windowsAdapter } from './windows-adapter.mjs';
const terminal=new Set(['succeeded','rolled_back','failed','recovery_required','deferred']);
export function parseEnv(text){const result={};for(const line of text.split(/\r?\n/)){const m=/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line);if(m)result[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}return result;}
export async function createAgent(config,{adapter,fetchImpl=fetch,wait=delay}={}){
 const central=serviceUrl(config.central_url),local=serviceUrl(config.api_url,{local:true});
 if(!identifier(config.node_id)||!textIdentity(config.un_id)||typeof config.token!=='string'||config.token.length<32||config.token.startsWith('REPLACE_')||!Number.isInteger(config.poll_seconds)||config.poll_seconds<5||config.poll_seconds>300)throw fault('INVALID_CONFIG','Invalid agent identity, token or poll interval');
 const publicKey=await readFile(config.release_public_key,'utf8');
 const dataDir=path.resolve(config.data_dir);await mkdir(dataDir,{recursive:true,mode:0o700});
 const journal=path.join(dataDir,'state.json');
 let state=await optionalJson(journal,{active:null,reports:[],completed:[]}),writes=Promise.resolve(),working=null,ticking=false;
 if(!Array.isArray(state.reports)||!Array.isArray(state.completed))throw fault('AGENT_STATE_INVALID','Agent journal is invalid');
 const save=()=>{const copy=structuredClone(state);writes=writes.then(()=>atomicJson(journal,copy));return writes;};
 if(state.active&&terminal.has(state.active.phase)){
  if(state.active.phase!=='deferred')state.completed=[...new Set([...state.completed,state.active.command.deployment_id])].slice(-100);
  state.active=null;await save();
 }
 adapter??=windowsAdapter(config);
 async function api(route,method='GET',body){
  const env=parseEnv(await readFile(config.env_file,'utf8'));
  if(env.UN_ID!==config.un_id||!env.API_KEY)throw fault('UN_ID_MISMATCH','Local .env identity differs from agent configuration');
  const res=await fetchImpl(local+route,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{'X-API-Key':env.API_KEY,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const data=await res.json();if(!res.ok&&route!=='/health')throw fault(data.error?.code||'LOCAL_API_FAILED','Local API request failed',res.status);return data;
 }
 async function control(route,body){const r=await fetchImpl(central+'/agent/'+config.node_id+'/'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw fault('CONTROL_UNAVAILABLE','Central service rejected the request',r.status);return r.json();}
 async function report(status,extra={}){state.active.phase=status;state.reports.push({deployment_id:state.active.command.deployment_id,report_id:randomUUID(),status,...extra});await save();}
 async function finish(status,extra={}){await report(status,extra);if(status!=='deferred')state.completed.push(state.active.command.deployment_id);state.completed=state.completed.slice(-100);state.active=null;await save();}
 async function download(command){
  const m=validateRelease(command.release,publicKey),file=path.join(dataDir,m.id+'.zip'),tmp=file+'.part';
  const res=await fetchImpl(central+'/agent/'+config.node_id+'/packages/'+m.id,{redirect:'error',signal:AbortSignal.timeout(300000),headers:{Authorization:'Bearer '+config.token}});
  if(!res.ok)throw fault('DOWNLOAD_FAILED','Package download failed');
  const {open,rename}=await import('node:fs/promises');const handle=await open(tmp,'w',0o600);let size=0;const hash=createHash('sha256');
  try{for await(const chunk of res.body){size+=chunk.length;if(size>m.size_bytes)throw fault('PACKAGE_MISMATCH','Package exceeds signed length');hash.update(chunk);await handle.writeFile(chunk);}}finally{await handle.close();}
  if(size!==m.size_bytes||hash.digest('hex')!==m.sha256){await unlink(tmp).catch(()=>{});throw fault('PACKAGE_MISMATCH','Package checksum mismatch');}
  await rename(tmp,file);return file;
 }
 function healthy(h,version){return h.un_id===config.un_id&&h.version===version&&['database','filesystem','browser'].every(k=>h.checks?.[k]?.status==='ok')&&Object.entries(h.checks||{}).every(([k,v])=>k==='maintenance'||v.status==='ok');}
 async function releaseMaintenance(owner){const m=await api('/api/v2/system/maintenance');if(m.active){if(m.owner!==owner)throw fault('MAINTENANCE_OWNER_MISMATCH','Another maintenance operation is active');await api('/api/v2/system/maintenance/end','POST',{owner});}}
 async function verify(owner,target){const h=await api('/health');if(!healthy(h,target))throw fault('HEALTH_FAILED','Target version is not healthy');const proof=await api('/api/v2/system/maintenance/verify','POST',{owner});if(!proof.verified||proof.version!==target||proof.un_id!==config.un_id)throw fault('SMOKE_FAILED','Fixed maintenance smoke test failed');}
 async function execute(command,recover=false){
  const owner='fleet-'+command.deployment_id;let m;
  let installing=false,maintenanceAttempted=recover;
  try{
   if(!identifier(command.deployment_id)||!Number.isInteger(command.drain_timeout_seconds)||command.drain_timeout_seconds<5||command.drain_timeout_seconds>86400||!Number.isFinite(Date.parse(command.deadline_at)))throw fault('INVALID_COMMAND','Invalid deployment id or maintenance window');
   if(!state.active){state.active={command,owner,phase:'assigned',started_at:new Date().toISOString()};await save();}
   m=validateRelease(command.release,publicKey);
   const initial=await api('/health');
   state.active.initial_version??=initial.version;await save();
   if(initial.un_id!==config.un_id||compareVersion(state.active.initial_version,m.min_api_version)<0)throw fault('BOOTSTRAP_REQUIRED','Install a maintenance-capable API first');
   if(!healthy(initial,initial.version))throw fault('LOCAL_API_FAILED','Local API readiness checks failed');
   if(!recover&&initial.maintenance?.active&&initial.maintenance.owner===owner)throw fault('INSTALL_OUTCOME_UNKNOWN','Maintenance exists but its local journal is missing');
   if(compareVersion(m.version,state.active.initial_version)<=0&&!recover)throw fault('VERSION_NOT_NEWER','Target must be newer than installed API');
   if(recover&&['installing','rolling_back'].includes(state.active.phase)){
    installing=true;
    const result=await adapter.recover(state.active);
    if(!result)throw fault('INSTALL_OUTCOME_UNKNOWN','Inspect local updater before releasing maintenance');
    if(result.rolled_back){await verify(owner,state.active.initial_version);await releaseMaintenance(owner);await finish('rolled_back',{version:state.active.initial_version,error_code:'UPDATE_FAILED'});return;}
    if(!result.updated||!result.backup)throw fault('INSTALL_OUTCOME_UNKNOWN','Updater completion is not confirmed');
    state.active.backup=result.backup;state.active.phase='verifying';await save();
   }
   if(!['verifying','ending'].includes(state.active.phase)){
    await report('draining');
    maintenanceAttempted=true;
    await api('/api/v2/system/maintenance/begin','POST',{owner,reason:'Централизованное обновление API'});
    const until=Math.min(Date.now()+command.drain_timeout_seconds*1000,Date.parse(command.deadline_at));
    for(;;){const check=await api('/api/v2/system/maintenance');if(check.owner!==owner)throw fault('MAINTENANCE_OWNER_MISMATCH','Maintenance owner changed');if(check.ready_to_update)break;if(Date.now()>=until)throw fault('DRAIN_TIMEOUT','Work did not finish in the maintenance window');await wait(2000);}
    await report('downloading');const file=await download(command);
    if(Date.now()>Date.parse(command.deadline_at))throw fault('DRAIN_TIMEOUT','Maintenance window expired before installation');
    await api('/api/v2/system/maintenance/seal','POST',{owner});
    installing=true;await report('installing');
    const result=await adapter.install({command,file,owner});
    if(result.rolled_back){await verify(owner,state.active.initial_version);await releaseMaintenance(owner);await finish('rolled_back',{version:state.active.initial_version,error_code:'UPDATE_FAILED'});return;}
    if(!result.updated||!result.backup)throw fault('INSTALL_OUTCOME_UNKNOWN','Updater did not confirm the outcome');
    state.active.backup=result.backup;await report('verifying');
   }
   installing=true;
   if(state.active.phase!=='ending')await verify(owner,m.version);
   state.active.phase='ending';await save();
   await releaseMaintenance(owner);
   const final=await api('/health');if(!final.ready||!healthy(final,m.version))throw fault('HEALTH_FAILED','API did not return to service');
   await finish('succeeded',{version:m.version});
  }catch(e){
   const code=/^[A-Z0-9_]{1,100}$/.test(e.code||'')?e.code:'AGENT_OPERATION_FAILED';
   if(!state.active)return;
   if(terminal.has(state.active.phase))throw e;
   if(!maintenanceAttempted&&!installing){await finish(['LOCAL_API_FAILED','CONTROL_UNAVAILABLE'].includes(code)?'deferred':'failed',{error_code:code});return;}
   if(state.active.phase==='ending'){await finish('recovery_required',{error_code:'SERVICE_RETURN_UNCONFIRMED'});return;}
   if(code==='INSTALL_OUTCOME_UNKNOWN'){await finish('recovery_required',{error_code:code});return;}
   if(installing&&state.active.backup){
    try{
     await report('verifying'); // keep the central slot while performing the local rollback
     state.active.phase='rolling_back';await save();
     const r=await adapter.rollback({backup:state.active.backup,owner,command});
     if(!r.rolled_back)throw fault('ROLLBACK_FAILED','Rollback unconfirmed');
     await verify(owner,state.active.initial_version);await releaseMaintenance(owner);
     await finish('rolled_back',{version:state.active.initial_version,error_code:code});return;
    }catch{await finish('recovery_required',{error_code:'ROLLBACK_FAILED'});return;}
   }
   if(installing){await finish('recovery_required',{error_code:code});return;}
   try{const current=await api('/api/v2/system/maintenance');if(current.active&&current.owner===owner)await releaseMaintenance(owner);}catch{await finish('recovery_required',{error_code:'MAINTENANCE_RELEASE_FAILED'});return;}
   await finish(['DRAIN_TIMEOUT','CONTROL_UNAVAILABLE'].includes(code)?'deferred':'failed',{error_code:code});
  }
 }
 return {
  get busy(){return !!working;},get state(){return structuredClone(state);},
  async tick({waitForWork=false}={}){
   if(ticking)return;ticking=true;
   try{
    while(state.reports.length){const r=state.reports[0];await control('reports/'+r.deployment_id,r);state.reports.shift();await save();}
    let health;try{health=await api('/health');}catch{health={};}
    const response=await control('heartbeat',{un_id:config.un_id,version:health.version||null,api_ready:health.ready===true,maintenance:health.maintenance?.active===true});
    if(!working){const recover=!!state.active,command=state.active?.command||response.command;if(command&&!state.completed.includes(command.deployment_id)){working=execute(command,recover).finally(()=>{working=null;});if(waitForWork)await working;}}
   }finally{ticking=false;}
  },
  async settle(){await working;await writes;}
 };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=JSON.parse(await readFile(process.argv[2],'utf8')),agent=await createAgent(config);
 let stopped=false;for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stopped=true;});
 while(!stopped){try{await agent.tick();}catch(e){console.error('Fleet agent tick failed:',e.code||'NETWORK_OR_STATE_ERROR');}await delay(config.poll_seconds*1000);}
 await agent.settle();
}
