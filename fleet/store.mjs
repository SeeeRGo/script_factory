import { DatabaseSync } from 'node:sqlite';
import { randomBytes,randomUUID } from 'node:crypto';
import { fault,hash,identifier,textIdentity,version } from './common.mjs';
const terminal=new Set(['succeeded','rolled_back','failed','recovery_required']);
const active=new Set(['assigned','draining','downloading','installing','verifying']);
const stages=new Set([...active,...terminal,'deferred']);
const now=()=>new Date().toISOString();
export function openFleetStore(file,{maxConcurrent=10}={}){
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
 const tables=['nodes','releases','rollouts','deployments'];
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
  overview:()=>mutate(s=>{for(const r of Object.values(s.rollouts))refresh(s,r);return {...s,nodes:Object.fromEntries(Object.entries(s.nodes).map(([id,{token_hash,...n}])=>[id,n]))};}),
  node(id){const row=selectNode.get(id),n=row?JSON.parse(row.body):null;return n&&!n.revoked?n:null;},
  addNode(input){return mutate(s=>{const {id,un_id,group='default'}=input;if(!identifier(id)||!textIdentity(un_id)||!textIdentity(group)||own(s.nodes,id)||Object.values(s.nodes).some(n=>n.un_id===un_id))throw fault('INVALID_NODE','Unique node id, UN_ID and group required');const token=randomBytes(32).toString('base64url');s.nodes[id]={id,un_id,group,token_hash:hash(token),created_at:now(),revoked:false};event(s,'node_created',{node_id:id});return {node:{id,un_id,group},token};});},
  credential(id,action){return mutate(s=>{const n=Object.hasOwn(s.nodes,id)?s.nodes[id]:null;if(!n)throw fault('NOT_FOUND','Node not found',404);if(action==='revoke'){n.revoked=true;event(s,'node_revoked',{node_id:id});return {revoked:true};}const token=randomBytes(32).toString('base64url');n.token_hash=hash(token);n.revoked=false;event(s,'node_token_rotated',{node_id:id});return {token};});},
  addRelease(envelope){return mutate(s=>{const m=envelope.manifest;if(s.releases[m.id])throw fault('RELEASE_EXISTS','Release ids are immutable',409);s.releases[m.id]={...envelope,ready:false,created_at:now()};event(s,'release_registered',{release_id:m.id});return s.releases[m.id];});},
  readyRelease(id){return mutate(s=>{const r=s.releases[id];if(!r)throw fault('NOT_FOUND','Release not found',404);r.ready=true;event(s,'release_ready',{release_id:id});return {ready:true};});},
  rollout(input){return mutate(s=>{
   const {release_id,node_ids,batch_size=10,canary_count=2,drain_timeout_seconds=1800,offline_timeout_seconds=180,start_at=now(),end_at=new Date(Date.now()+86400000).toISOString()}=input;
   if(!s.releases[release_id]?.ready||!Array.isArray(node_ids)||!node_ids.length||node_ids.length>1000||new Set(node_ids).size!==node_ids.length||node_ids.some(id=>!s.nodes[id]||s.nodes[id].revoked)||!Number.isInteger(batch_size)||batch_size<1||batch_size>50||!Number.isInteger(canary_count)||canary_count<1||canary_count>node_ids.length||!Number.isInteger(drain_timeout_seconds)||drain_timeout_seconds<5||drain_timeout_seconds>86400||!Number.isInteger(offline_timeout_seconds)||offline_timeout_seconds<60||offline_timeout_seconds>86400||!Number.isFinite(Date.parse(start_at))||!Number.isFinite(Date.parse(end_at))||Date.parse(end_at)<=Math.max(Date.parse(start_at),Date.now()))throw fault('INVALID_ROLLOUT','Invalid targets, ready release, batch, pilot or window');
   if(Object.values(s.deployments).some(d=>node_ids.includes(d.node_id)&&(active.has(d.status)||d.status==='queued'||d.status==='recovery_required')))throw fault('NODE_BUSY','A target already has an unfinished deployment',409);
   const id=randomUUID();s.rollouts[id]={id,release_id,node_ids,batch_size,canary_ids:node_ids.slice(0,canary_count),drain_timeout_seconds,offline_timeout_seconds,start_at,end_at,status:'running',created_at:now()};
   for(const node_id of node_ids){const id2=randomUUID();s.deployments[id2]={id:id2,rollout_id:id,node_id,release_id,status:'queued',attempts:0};}
   event(s,'rollout_created',{rollout_id:id,release_id});return s.rollouts[id];
  });},
  control(id,action){return mutate(s=>{const r=own(s.rollouts,id);if(!r||['completed','cancelled'].includes(r.status))throw fault('INVALID_ROLLOUT','Rollout not found or already final',409);if(action==='resume'&&Object.values(s.deployments).some(d=>d.rollout_id===id&&['failed','rolled_back','recovery_required'].includes(d.status)))throw fault('RETRY_REQUIRED','Failed nodes require explicit retry or recovery first',409);r.status=action==='pause'?'paused':action==='cancel'?'cancelled':'running';if(action==='cancel')for(const d of Object.values(s.deployments))if(d.rollout_id===id&&d.status==='queued')d.status='cancelled';r.pause_reason=action==='pause'?'ADMIN_PAUSED':null;event(s,'rollout_'+action,{rollout_id:id});return r;});},
  retry(id){return mutate(s=>{const d=s.deployments[id];if(!d||!['failed','rolled_back'].includes(d.status))throw fault('INVALID_RETRY','Only failed or rolled-back deployments may be retried',409);const n={...d,id:randomUUID(),status:'queued',attempts:0};delete n.assigned_at;delete n.error_code;s.deployments[n.id]=n;d.status='superseded';event(s,'deployment_retried',{deployment_id:id,replacement:n.id});return n;});},
  resolve(id,input){return mutate(s=>{const d=s.deployments[id],n=d&&s.nodes[d.node_id];if(!d||d.status!=='recovery_required'||input.confirm_recovered!==true||!n.api_ready||n.maintenance||!n.last_seen||n.heartbeat_serial<=d.recovery_serial||Date.now()-Date.parse(n.last_seen)>180000)throw fault('RECOVERY_NOT_CONFIRMED','Requires manual recovery and a fresh healthy agent heartbeat',409);d.status='failed';d.error_code='RECOVERY_CONFIRMED';event(s,'recovery_confirmed',{deployment_id:id,node_id:d.node_id});return {resolved:true};});},
  heartbeat(id,input){return mutate(s=>{
   const n=s.nodes[id];if(!n||n.revoked)throw fault('UNAUTHORIZED','Agent credential revoked',401);
   if(input.un_id!==n.un_id)throw fault('UN_ID_MISMATCH','Configured UN_ID does not match registration',409);
   n.last_seen=now();n.heartbeat_serial=(n.heartbeat_serial||0)+1;n.version=version(input.version)?input.version:n.version||null;n.api_ready=input.api_ready===true;n.maintenance=input.maintenance===true;n.agent_version='1';
   for(const r of Object.values(s.rollouts))refresh(s,r);
   let d=Object.values(s.deployments).find(d=>d.node_id===id&&active.has(d.status));
   if(!d&&Object.values(s.deployments).filter(d=>active.has(d.status)||d.status==='recovery_required').length<maxConcurrent)for(const r of Object.values(s.rollouts)){
    if(r.status!=='running'||Date.now()<Date.parse(r.start_at)||Date.now()>Date.parse(r.end_at))continue;
    const ds=Object.values(s.deployments).filter(d=>d.rollout_id===r.id&&d.status!=='superseded');
    const pilotDone=r.canary_ids.every(id=>ds.some(d=>d.node_id===id&&d.status==='succeeded'));
    if(!pilotDone&&!r.canary_ids.includes(id))continue;
    if(ds.filter(d=>active.has(d.status)).length>=r.batch_size)continue;
    const next=ds.find(d=>d.node_id===id&&d.status==='queued'&&(!d.retry_at||Date.parse(d.retry_at)<=Date.now()));
    if(next){d=next;d.status='assigned';d.assigned_at=now();d.attempts++;event(s,'deployment_assigned',{deployment_id:d.id,node_id:id});break;}
   }
   return {command:d?{deployment_id:d.id,release:s.releases[d.release_id],drain_timeout_seconds:s.rollouts[d.rollout_id].drain_timeout_seconds,deadline_at:s.rollouts[d.rollout_id].end_at}:null};
  });},
  report(id,deployment_id,input){return mutate(s=>{
   const d=s.deployments[deployment_id];if(!d||d.node_id!==id)throw fault('NOT_FOUND','Deployment not found',404);
   if(input.report_id&&(d.report_ids||[]).includes(input.report_id))return {accepted:true};
   if(!stages.has(input.status))throw fault('INVALID_REPORT','Invalid deployment state');
   if(terminal.has(d.status)||d.status==='superseded'){if(d.status===input.status)return {accepted:true};throw fault('DEPLOYMENT_FINISHED','Deployment is already final',409);}
   if(d.status==='queued')throw fault('DEPLOYMENT_NOT_ASSIGNED','No assigned command',409);
   if(input.report_id&&!identifier(input.report_id))throw fault('INVALID_REPORT','Invalid report id');
   if(typeof input.error_code==='string'&&!/^[A-Z0-9_]{1,100}$/.test(input.error_code))throw fault('INVALID_REPORT','Only a technical error code may be reported');
   if(input.status==='succeeded'&&input.version!==s.releases[d.release_id].manifest.version)throw fault('VERSION_MISMATCH','Success requires the exact target version',409);
   d.status=input.status;d.updated_at=now();d.error_code=input.error_code||null;
   if(input.status==='recovery_required'){d.recovery_serial=s.nodes[id].heartbeat_serial||0;s.nodes[id].api_ready=false;}
   if(input.report_id)d.report_ids=[...(d.report_ids||[]),input.report_id].slice(-30);
   if(input.status==='deferred'){d.status=d.attempts>=3?'failed':'queued';d.retry_at=new Date(Date.now()+60000).toISOString();}
   if(version(input.version))s.nodes[id].version=input.version;
   event(s,'deployment_report',{deployment_id,node_id:id,status:d.status,error_code:d.error_code});refresh(s,s.rollouts[d.rollout_id]);return {accepted:true};
  });},
  mayDownload(id,release_id){return Object.values(read().deployments).some(d=>d.node_id===id&&d.release_id===release_id&&active.has(d.status));}
 };
}
