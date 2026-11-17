import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {serviceUrl,hash,releaseBytes} from '../fleet/common.mjs';
import {createFleetServer} from '../fleet/server.mjs';
import {createAgent} from '../fleet/agent.mjs';

test('fleet accepts explicit HTTP and HTTPS central origins without an IP/domain whitelist',()=>{
 for(const value of ['http://192.168.88.10:34001','http://fleet.internal:34001','http://127.0.0.2:34001','http://[fd00::1]:34001','https://fleet.example.org'])assert.equal(serviceUrl(value),value);
 for(const value of ['ftp://fleet.internal','http://user:password@fleet.internal','http://fleet.internal/api','http://fleet.internal/?token=secret','http://fleet.internal/#fragment','invalid'])assert.throws(()=>serviceUrl(value),{code:'INVALID_URL'});
 assert.equal(serviceUrl('http://127.0.0.1:33001',{local:true}),'http://127.0.0.1:33001');
 assert.throws(()=>serviceUrl('http://192.168.88.10:33001',{local:true}),{code:'INVALID_URL'});
});

test('HTTP enrollment, release publication and agent heartbeat work outside the old loopback allowlist',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'sf-fleet-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'pem',type:'spki'});
 const adminToken='test-http-fleet-admin-token-at-least-32-characters';
 const {server,store}=await createFleetServer({dataDir:path.join(root,'central'),adminToken,publicKey});
 // 127.0.0.2 is a real reachable HTTP endpoint, but was rejected by the previous
 // validator. The agent additionally uses a LAN URL with a fetch routing adapter.
 await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const actual='http://127.0.0.2:'+server.address().port,lan='http://192.168.88.10:34001';
 const inventory=path.join(root,'nodes.json'),out=path.join(root,'enrollments');
 await writeFile(inventory,JSON.stringify([{id:'http-un',un_id:'http-un'}]));
 const run=(file,args)=>promisify(execFile)(process.execPath,[file,...args],{env:{...process.env,FLEET_ADMIN_TOKEN:adminToken}});
 await run('scripts/fleet-enroll.mjs',['--url',actual,'--inventory',inventory,'--out',out]);
 const config=JSON.parse(await readFile(path.join(out,'http-un.json'),'utf8'));assert.equal(config.central_url,actual);assert.equal(store.node('http-un').un_id,'http-un');
 const bytes=Buffer.from('PK-http-package');
 const manifest={id:'http-release',version:'0.14.1',release_date:'17.11.2026',commit:'a'.repeat(40),sha256:hash(bytes),size_bytes:bytes.length,min_api_version:'0.11.0',node_major:24,database_schema:'unchanged'};
 const envelope={manifest,signature:sign(null,releaseBytes(manifest),keys.privateKey).toString('base64')};
 const manifestFile=path.join(root,'release.json'),zip=path.join(root,'release.zip');await writeFile(manifestFile,JSON.stringify(envelope));await writeFile(zip,bytes);
 await run('scripts/fleet-release.mjs',['publish','--url',actual,'--manifest',manifestFile,'--zip',zip]);assert.equal(store.read().releases[manifest.id].ready,true);
 const key=path.join(root,'public.pem'),env=path.join(root,'worker.env');await writeFile(key,publicKey);await writeFile(env,'UN_ID=http-un\nAPI_KEY=http-api-secret\n');
 const routes=[];
 const fetchImpl=async(url,options)=>{
  routes.push(String(url));
  if(String(url).startsWith(lan))return fetch(actual+String(url).slice(lan.length),options);
  if(String(url).endsWith('/health'))return new Response(JSON.stringify({ready:true,version:'0.14.0',un_id:'http-un',queue:{running:0,queued:0}}),{headers:{'Content-Type':'application/json'}});
  throw new Error('Unexpected URL '+url);
 };
 const agent=await createAgent({...config,central_url:lan,env_file:env,data_dir:path.join(root,'agent'),release_public_key:key},{fetchImpl,adapter:{}});
 await agent.tick({waitForWork:true});
 assert.ok(routes.some(url=>url===lan+'/agent/http-un/heartbeat'));
 assert.ok(store.node('http-un').last_seen);
 assert.ok((await readdir(out)).includes('http-un.json'));
});
