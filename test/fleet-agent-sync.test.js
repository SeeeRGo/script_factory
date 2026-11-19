import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createAgent} from '../fleet/agent.mjs';

test('agent replacement proof requires an accepted heartbeat and identifies installed source',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'sf-agent-contact-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const key=path.join(root,'release-public.pem'),env=path.join(root,'.env'),data=path.join(root,'data');
 await writeFile(key,generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}));
 await writeFile(env,'UN_ID=test-un\nAPI_KEY=fixture-api-key\n');
 await writeFile(path.join(root,'agent-source.json'),'{"version":"0.17.0"}');
 await writeFile(path.join(root,'agent-sync-result.json'),'{"status":"pending"}');
 let accepted=false,heartbeat;
 const agent=await createAgent({node_id:'test-node',un_id:'test-un',token:'fixture-agent-key-longer-than-32-characters',central_url:'http://192.0.2.1:34001',api_url:'http://127.0.0.1:33001',env_file:env,release_public_key:key,data_dir:data,poll_seconds:5},{adapter:{},fetchImpl:async(url,options)=>{
  if(String(url).endsWith('/health'))return Response.json({ready:true,un_id:'test-un',version:'0.17.0'});
  heartbeat=JSON.parse(options.body);return Response.json({command:null},{status:accepted?200:401});
 }});
 await assert.rejects(agent.tick(),{code:'CONTROL_UNAVAILABLE'});
 await assert.rejects(readFile(path.join(data,'agent-contact.json')),{code:'ENOENT'});
 accepted=true;await agent.tick();
 const proof=JSON.parse(await readFile(path.join(data,'agent-contact.json'),'utf8'));
 assert.equal(proof.node_id,'test-node');assert.equal(proof.source_version,'0.17.0');assert.equal(proof.pid,process.pid);assert.ok(Number.isFinite(Date.parse(proof.at)));
 assert.equal(heartbeat.agent_source_version,'0.17.0');assert.equal(heartbeat.agent_update_status,'pending');assert.equal(heartbeat.token,undefined);
});
