import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {createFleetServer} from '../fleet/server.mjs';
import {createServer} from 'node:http';
const token='test-enrollment-admin-key-at-least-32-characters';
async function fixture(t,handler){
 const root=await mkdtemp(path.join(tmpdir(),'sf-enrollment-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let server,store;let posts=0;
 if(handler)server=createServer(handler);else({server,store}=await createFleetServer({dataDir:path.join(root,'central'),adminToken:token,publicKey:generateKeyPairSync('ed25519').publicKey}));
 server.on('request',req=>{if(req.method==='POST')posts++;});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const inventory=path.join(root,'nodes.json'),out=path.join(root,'out');
 return {root,inventory,out,store,get posts(){return posts;},async run(nodes,credential=token){await writeFile(inventory,JSON.stringify(nodes));try{return await promisify(execFile)(process.execPath,['scripts/fleet-enroll.mjs','--url','http://127.0.0.1:'+server.address().port,'--inventory',inventory,'--out',out],{env:{...process.env,FLEET_ADMIN_TOKEN:credential}});}catch(error){return error;}}};
}
test('revoked UN_ID with another id is diagnosed before any new node is registered',async t=>{
 const f=await fixture(t);f.store.addNode({id:'existing',un_id:'same-un'});f.store.credential('existing','revoke');const before=f.store.read().nodes.existing.token_hash;
 const r=await f.run([{id:'new-node',un_id:'new-un'},{id:'different-id',un_id:'same-un',network_address:'192.168.88.246'}]);
 assert.equal(r.code,1);assert.match(r.stdout,/existing/);assert.match(r.stdout,/ключ отозван/);assert.match(r.stdout,/Регистрация не началась/);assert.equal(r.stderr,'');assert.equal(f.posts,0);assert.equal(f.store.read().nodes['new-node'],undefined);assert.equal(f.store.read().nodes.existing.revoked,true);assert.equal(f.store.read().nodes.existing.token_hash,before);await assert.rejects(access(f.out));
});
test('wrong administrative token is reported with HTTP status and code on stdout',async t=>{
 const f=await fixture(t);const r=await f.run([{id:'one',un_id:'un-one'}],'wrong-key');assert.equal(r.code,1);assert.match(r.stdout,/HTTP 401.*UNAUTHORIZED/);assert.equal(r.stderr,'');assert.equal(f.posts,0);
});
test('POST failures preserve the server reason, hide credentials and keep a failing exit code',async t=>{
 const f=await fixture(t,(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({nodes:{}}));return;}res.writeHead(400);res.end(JSON.stringify({error:{code:'INVALID_NODE',message:'invalid node '+token}}));});
 const r=await f.run([{id:'one',un_id:'un-one'}]);assert.equal(r.code,1);assert.match(r.stdout,/HTTP 400.*INVALID_NODE/);assert.match(r.stdout,/one/);assert.doesNotMatch(r.stdout,new RegExp(token));assert.equal(r.stderr,'');
});
