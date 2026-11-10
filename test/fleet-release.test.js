import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {validateRelease,hash,releaseBytes} from '../fleet/common.mjs';
import {createFleetServer} from '../fleet/server.mjs';

test('release builder signs the committed runtime and excludes even force-tracked credentials',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'sf-release-builder-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo');await mkdir(repo);
 const fixture={
  'package.json':JSON.stringify({version:'0.11.1',releaseDate:'09.11.2026'}),'package-lock.json':'{}','openapi.yaml':'openapi: 3.0.0',
  '.env.example':'API_KEY=placeholder','src/server.js':'console.log("safe")','public/index.html':'<p>safe</p>',
  'windows/start-worker.ps1':'# safe','windows/.env.example':'API_KEY=placeholder',
  'fleet/agent.mjs':'// safe','fleet/agent.config.example.json':'{}','fleet/controller.env.example':'FLEET_ADMIN_TOKEN=placeholder',
  'docs/project-guide/tools/update-one-un.ps1':'# safe',
  '.env':'API_KEY=private','fleet/agent.config.json':'{"token":"private"}','fleet/controller.env':'FLEET_ADMIN_TOKEN=private',
  'fleet/release-private.pem':'private','windows/worker.env':'API_KEY=private','work/report.xml':'private','outputs/secret.json':'private'
 };
 for(const [name,body] of Object.entries(fixture)){const file=path.join(repo,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,body);}
 const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 git('init');git('add','.');git('-c','user.name=Release Test','-c','user.email=test@example.invalid','commit','-m','fixture');
 const keys=generateKeyPairSync('ed25519'),keyFile=path.join(root,'private.pem');await writeFile(keyFile,keys.privateKey.export({format:'pem',type:'pkcs8'}));
 const out=path.join(root,'release');
 execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/fleet-release.mjs',import.meta.url)),'build','--ref','HEAD','--out',out,'--key',keyFile],{cwd:repo,stdio:'pipe'});
 const files=await readdir(out),envelope=JSON.parse(await readFile(path.join(out,files.find(f=>f.endsWith('.json'))),'utf8'));
 validateRelease(envelope,keys.publicKey);
 const zip=await readFile(path.join(out,files.find(f=>f.endsWith('.zip'))));
 const end=zip.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert.ok(end>0);
 let offset=zip.readUInt32LE(end+16);const names=[];
 for(let i=0;i<zip.readUInt16LE(end+10);i++){
  assert.equal(zip.readUInt32LE(offset),0x02014b50);const n=zip.readUInt16LE(offset+28),extra=zip.readUInt16LE(offset+30),comment=zip.readUInt16LE(offset+32);
  names.push(zip.subarray(offset+46,offset+46+n).toString());offset+=46+n+extra+comment;
 }
 for(const name of ['.env','fleet/agent.config.json','fleet/controller.env','fleet/release-private.pem','windows/worker.env','work/report.xml','outputs/secret.json'])assert.equal(names.includes(name),false,name+' must not be distributed');
 for(const name of ['src/server.js','fleet/agent.mjs','.env.example','windows/.env.example','fleet/controller.env.example'])assert.equal(names.includes(name),true);
});

test('key generation creates a matching trusted pair and refuses to replace existing keys',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sf-signing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tool=fileURLToPath(new URL('../scripts/fleet-release.mjs',import.meta.url));
 execFileSync(process.execPath,[tool,'keygen','--out',dir],{stdio:'pipe'});
 const privateKey=await readFile(path.join(dir,'release-private.pem'),'utf8'),publicKey=await readFile(path.join(dir,'release-public.pem'),'utf8');
 assert.equal(typeof privateKey,'string');assert.ok(publicKey.includes('PUBLIC KEY'));
 assert.throws(()=>execFileSync(process.execPath,[tool,'keygen','--out',dir],{stdio:'pipe'}));
 assert.equal(await readFile(path.join(dir,'release-private.pem'),'utf8'),privateKey);
});

test('CLI publishing resumes an incomplete release and enrollment writes a unique local configuration',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sf-fleet-tools-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const keys=generateKeyPairSync('ed25519'),adminToken='test-only-admin-credential-32-characters';
 const {server,store}=await createFleetServer({dataDir:path.join(dir,'central'),adminToken,publicKey:keys.publicKey});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const bytes=Buffer.from('PK-signed-test');const manifest={id:'tools-release',version:'0.11.1',release_date:'09.11.2026',commit:'a'.repeat(40),sha256:hash(bytes),size_bytes:bytes.length,min_api_version:'0.11.0',node_major:24,database_schema:'unchanged'};
 const envelope={manifest,signature:sign(null,releaseBytes(manifest),keys.privateKey).toString('base64')};store.addRelease(envelope);
 const manifestFile=path.join(dir,'manifest.json'),zip=path.join(dir,'package.zip');await writeFile(manifestFile,JSON.stringify(envelope));await writeFile(zip,bytes);
 const run=async(tool,args)=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/'+tool,import.meta.url)),...args],{env:{...process.env,FLEET_ADMIN_TOKEN:adminToken}});
 const publish=['publish','--url',origin,'--manifest',manifestFile,'--zip',zip];await run('fleet-release.mjs',publish);assert.equal(store.read().releases[manifest.id].ready,true);
 assert.match((await run('fleet-release.mjs',publish)).stdout,/already published/);
 const inventory=path.join(dir,'inventory.json'),out=path.join(dir,'enrollment');await writeFile(inventory,JSON.stringify([{id:'test-un',un_id:'Тестовая УН',group:'Пилот'}]));
 const result=await run('fleet-enroll.mjs',['--url',origin,'--inventory',inventory,'--out',out]);
 const config=JSON.parse(await readFile(path.join(out,'test-un.json'),'utf8'));assert.equal(config.un_id,'Тестовая УН');assert.equal(config.api_url,'http://127.0.0.1:33001');assert.equal(result.stdout.includes(config.token),false);assert.equal(store.node('test-un').token_hash,hash(config.token));
});
