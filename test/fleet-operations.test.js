import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {openFleetStore} from '../fleet/store.mjs';
import {createFleetServer} from '../fleet/server.mjs';
import {hash,releaseBytes} from '../fleet/common.mjs';
import {historyPage,operationBlocker,operationDiagnostics} from '../fleet/operations.mjs';
const pair=generateKeyPairSync('ed25519'),admin='test-operations-administrative-key-at-least-32-chars';
const manifest={id:'r',version:'0.15.4',release_date:'18.11.2026',commit:'a'.repeat(40),sha256:hash('package'),size_bytes:7,min_api_version:'0.11.0',node_major:24,database_schema:'unchanged'};
const envelope={manifest,signature:sign(null,releaseBytes(manifest),pair.privateKey).toString('base64')};
const beat={un_id:'one',version:'0.15.3',api_ready:true,maintenance:false};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'sf-operations-'));t.after(()=>rm(root,{recursive:true,force:true}));const s=openFleetStore(path.join(root,'fleet.sqlite'));t.after(()=>s.close());s.addNode({id:'one',un_id:'one',network_address:'192.0.2.1'});s.addRelease(envelope);s.readyRelease('r');return {s,root};}
function start(s){const r=s.rollout({release_id:'r',node_ids:['one'],canary_count:1});return {r,d:Object.values(s.read().deployments).find(d=>d.rollout_id===r.id)};}
test('node deletion requires confirmation, preserves historical identity and blocks old operations after re-registration',async t=>{
 const {s}=await fixture(t),{r,d}=start(s);assert.throws(()=>s.deleteNode('one',{confirm_delete:true}),{code:'NODE_BUSY'});
 s.heartbeat('one',beat);s.report('one',d.id,{status:'failed',error_code:'UPDATE_FAILED'});
 assert.throws(()=>s.deleteNode('one',{}),{code:'DELETE_CONFIRMATION_REQUIRED'});
 s.deleteNode('one',{confirm_delete:true});assert.equal(s.node('one'),null);
 const history=s.read().deployments[d.id];assert.equal(history.target_un_id,'one');assert.equal(history.target_address,'192.0.2.1');assert.ok(history.node_deleted_at);assert.ok(s.read().rollouts[r.id]);
 s.addNode({id:'one',un_id:'one',network_address:'192.0.2.2'});
 assert.throws(()=>s.retry(d.id),{code:'NODE_REMOVED'});assert.throws(()=>s.report('one',d.id,{status:'failed'}),{code:'NODE_REMOVED'});
 assert.equal(s.diagnostics(d.id).address,'192.0.2.1');assert.ok(s.diagnostics(d.id).node_deleted);
});
test('active, uncertain and maintenance nodes cannot be deleted',async t=>{
 const {s}=await fixture(t),{d}=start(s);s.heartbeat('one',beat);assert.throws(()=>s.deleteNode('one',{confirm_delete:true}),{code:'NODE_BUSY'});
 s.report('one',d.id,{status:'recovery_required',error_code:'INSTALL_OUTCOME_UNKNOWN'});assert.throws(()=>s.deleteNode('one',{confirm_delete:true}),{code:'NODE_BUSY'});
 s.heartbeat('one',beat);s.resolve(d.id,{confirm_recovered:true});s.heartbeat('one',{...beat,maintenance:true});assert.throws(()=>s.deleteNode('one',{confirm_delete:true}),{code:'NODE_BUSY'});
});
test('window rescheduling and retry have explicit guards; queued retry resumes only after failures resolved',async t=>{
 const {s}=await fixture(t),{r,d}=start(s);s.heartbeat('one',beat);
 assert.throws(()=>s.reschedule(r.id,{start_at:new Date().toISOString(),end_at:new Date(Date.now()+60000).toISOString()}),{code:'ROLLOUT_BUSY'});
 s.report('one',d.id,{status:'failed',error_code:'UPDATE_FAILED'});
 assert.throws(()=>s.control(r.id,'resume'),{code:'RETRY_REQUIRED'});
 assert.throws(()=>s.reschedule(r.id,{start_at:'bad',end_at:'bad'}),{code:'INVALID_WINDOW'});
 s.reschedule(r.id,{start_at:new Date().toISOString(),end_at:new Date(Date.now()+60000).toISOString()});assert.equal(s.read().rollouts[r.id].status,'paused');
 const retry=s.retry(d.id);assert.equal(s.heartbeat('one',beat).command,null);s.control(r.id,'resume');assert.equal(s.heartbeat('one',beat).command.deployment_id,retry.id);
});
test('cancelled or expired rollouts do not produce silently stuck retries',async t=>{
 const {s}=await fixture(t),{r,d}=start(s);s.heartbeat('one',beat);s.report('one',d.id,{status:'failed'});s.control(r.id,'cancel');assert.throws(()=>s.retry(d.id),{code:'ROLLOUT_CLOSED'});
 const next=start(s);s.heartbeat('one',beat);s.report('one',next.d.id,{status:'failed'});
 const realNow=Date.now;Date.now=()=>realNow()+2*86400000;
 try{assert.throws(()=>s.retry(next.d.id),{code:'WINDOW_EXPIRED'});assert.throws(()=>s.control(next.r.id,'resume'),{code:'WINDOW_EXPIRED'});}finally{Date.now=realNow;}
});
test('history filtering supports error groups, addresses, inclusive dates and stable pagination',()=>{
 const items=Array.from({length:60},(_,i)=>({id:String(i),status:i%2?'succeeded':'failed',target_address:'192.0.2.1',created_at:'2026-11-19T12:00:00'}));
 const first=historyPage(items,{query:'192.0.2.1',status:'errors',from:'2026-11-19',to:'2026-11-19',limit:25});assert.equal(first.total,30);assert.equal(first.items.length,25);assert.equal(first.pages,2);
 assert.equal(historyPage(items,{status:'errors',page:2,limit:25}).items.length,5);assert.equal(historyPage(items,{from:'2026-11-20'}).total,0);
 assert.equal(historyPage([{status:'paused',pause_reason:'WINDOW_UPDATED'}],{status:'errors'}).total,0);
});
test('diagnostics distinguish pause/window/contact/pilot and never claim to contain remote transcripts',()=>{
 const now=Date.now(),s={nodes:{one:{last_seen:new Date(now).toISOString(),api_ready:true}},rollouts:{r:{id:'r',status:'paused',start_at:new Date(now-1000).toISOString(),end_at:new Date(now+60000).toISOString(),canary_ids:['pilot'],batch_size:1}},deployments:{}},d={id:'op',node_id:'one',rollout_id:'r',status:'queued'};
 assert.match(operationBlocker(d,s,now),/паузе/);s.rollouts.r.status='running';assert.match(operationBlocker(d,s,now),/пилотных/);
 s.nodes.one.last_seen=null;assert.match(operationBlocker(d,s,now),/контакта/);
 s.rollouts.r.end_at=new Date(now-1).toISOString();assert.match(operationBlocker(d,s,now),/истекло/);
 const diagnostics=operationDiagnostics(d,s,now);assert.ok(diagnostics.local_logs.some(p=>p.endsWith('op.result.json.log')));assert.match(diagnostics.note,/на самой УН/);
});
test('HTTP deletion and diagnostics require admin; removed rows stay removed after restart',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'sf-ops-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let {server,store}=await createFleetServer({dataDir:root,adminToken:admin,publicKey:pair.publicKey});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;const enrollment=store.addNode({id:'one',un_id:'one'});
 store.addRelease(envelope);store.readyRelease('r');const {r,d}=start(store);store.heartbeat('one',beat);store.report('one',d.id,{status:'failed',error_code:'UPDATE_FAILED'});
 assert.equal((await fetch(base+'/api/deployments/'+d.id+'/diagnostics')).status,401);
 const diagnostic=await fetch(base+'/api/deployments/'+d.id+'/diagnostics',{headers:{Authorization:'Bearer '+admin}});assert.equal(diagnostic.status,200);const details=await diagnostic.json();assert.ok(details.local_logs.some(p=>p.endsWith(d.id+'.result.json.log')));assert.ok(details.events.length);assert.ok(!JSON.stringify(details).includes(enrollment.token));
 const window=await fetch(base+'/api/rollouts/'+r.id+'/window',{method:'PUT',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:JSON.stringify({start_at:new Date().toISOString(),end_at:new Date(Date.now()+60000).toISOString()})});assert.equal(window.status,200);

 assert.equal((await fetch(base+'/api/nodes/one',{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{"confirm_delete":true}'})).status,401);
 assert.equal((await fetch(base+'/api/nodes/one',{method:'DELETE',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:'{"confirm_delete":true}'})).status,200);
 assert.equal((await fetch(base+'/agent/one/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+enrollment.token},body:JSON.stringify(beat)})).status,401);
 await new Promise(r=>server.close(r));const reopened=openFleetStore(path.join(root,'fleet.sqlite'));try{assert.equal(reopened.node('one'),null);}finally{reopened.close();}
});
