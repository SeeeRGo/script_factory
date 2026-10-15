import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPowerManager, powerDefaults } from '../src/power-management.js';
import { handlePowerRequest } from '../src/power-http.js';
const sendJson = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const readJsonBody = async req => { let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text||'{}'); };
test('API returns only acceptance before inspecting users, coalesces checks, and rejects invalid calls', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'power-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let inspections=0, emitted=0, busy=true;
  const manager=await createPowerManager({dataDir:dir,defaults:{...powerDefaults({}),enabled:true,dry_run:true,grace_seconds:0},getBlockers:()=>busy?['JOBS_PENDING']:[],adapter:{supported:true,inspect:async()=>{inspections++;assert.ok(emitted>0);return{complete:true,excluded_sid:'robot',sessions:[],suspend_supported:true,suspend_privilege:true};},suspend:async()=>assert.fail()}});
  t.after(()=>manager.close());
  const server=http.createServer(async(req,res)=>{try{
    if(req.headers['x-api-key']!=='test-key'){sendJson(res,401,{error:{code:'UNAUTHORIZED'}});return;}
    res.once('finish',()=>{emitted++;});
    if(!await handlePowerRequest({req,res,method:req.method,resourcePath:req.url,powerManager:manager,readJsonBody,sendJson}))sendJson(res,404,{});
  }catch(e){sendJson(res,e.statusCode||500,{error:{code:e.code}});}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const request=(route,opts={})=>fetch(`http://127.0.0.1:${server.address().port}/system/power/${route}`,{headers:{'X-API-Key':'test-key','Content-Type':'application/json'},...opts});
  let response=await request('suspend',{method:'POST',body:'{}'});assert.equal(response.status,202);assert.deepEqual(await response.json(),{status:'accepted'});
  while(manager.status().last.reason!=='JOBS_PENDING'||manager.status().checking)await new Promise(r=>setTimeout(r,5));assert.equal(inspections,0);
  busy=false;response=await request('suspend',{method:'POST',body:'{}'});assert.equal(response.status,202);
  while(manager.status().last.reason!=='WOULD_SUSPEND'||manager.status().checking)await new Promise(r=>setTimeout(r,5));assert.equal(inspections,2);
  assert.equal((await request('suspend',{method:'POST',body:'{"force":true}'})).status,400);
  assert.equal((await request('suspend',{method:'POST',body:'{}',headers:{}})).status,401);
  response=await request('config',{method:'PATCH',body:'{"enabled":false}'});assert.equal(response.status,200);
  assert.equal((await request('suspend',{method:'POST',body:'{}'})).status,503);
  assert.equal((await request('cancel',{method:'POST',body:'{}'})).status,200);
});

test('real server authenticates power endpoints and persists settings across restart without changing job config', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'power-server-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  let child;
  const start=async()=>{
    child=spawn(process.execPath,['src/server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,API_KEY:'test-power-key',WEB_LOGIN:'power-test',WEB_PASSWORD:'power-test',UN_ID:'power-test',POWER_ENABLED:'false',POWER_BACKGROUND_ENABLED:'false',POWER_DRY_RUN:'true'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
    for(let i=0;i<200;i++){if(output.includes('script-factory listening'))return;if(child.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,20));}throw new Error('Server startup timed out');
  };
  const stop=async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}};t.after(stop);
  await start();
  const request=(route,opts={})=>fetch(`http://127.0.0.1:${port}/api/v2${route}`,{headers:{'X-API-Key':'test-power-key','Content-Type':'application/json'},...opts});
  assert.equal((await request('/system/power/status',{headers:{}})).status,401);
  const before=await(await request('/system/config')).json();
  assert.equal((await request('/system/power/config',{method:'PATCH',body:'{"excluded_user":"TEST\\\\Robot","user_idle_seconds":700}'})).status,200);
  assert.equal((await request('/system/power/config',{method:'PATCH',body:'{"user_idle_seconds":0}'})).status,400);
  assert.equal((await request('/system/power/suspend',{method:'POST',body:'{}'})).status,503);
  assert.deepEqual(await(await request('/system/config')).json(),before);
  await stop();await start();
  const config=(await(await request('/system/power/config')).json()).config;assert.equal(config.user_idle_seconds,700);assert.equal(config.excluded_user,'TEST\\Robot');
  assert.equal((JSON.parse(await readFile(path.join(dir,'power/config.json'),'utf8'))).user_idle_seconds,700);
});
