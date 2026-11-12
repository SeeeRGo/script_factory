import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serviceUrl,identifier,textIdentity,privateDirectory } from '../fleet/common.mjs';
const args=process.argv.slice(2);const arg=n=>{const i=args.indexOf('--'+n);if(i<0||!args[i+1])throw new Error('Missing --'+n);return args[i+1];};
const base=serviceUrl(arg('url')),out=path.resolve(arg('out')),nodes=JSON.parse(await readFile(arg('inventory'),'utf8'));
if(!process.env.FLEET_ADMIN_TOKEN||!Array.isArray(nodes)||!nodes.length)throw new Error('Set FLEET_ADMIN_TOKEN and provide an inventory array');
await privateDirectory(out);
for(const n of nodes){
 if(!identifier(n.id)||!textIdentity(n.un_id))throw new Error('Invalid inventory node identity');
 const r=await fetch(base+'/api/nodes',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+process.env.FLEET_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({id:n.id,un_id:n.un_id,group:n.group||'default',...Object.fromEntries(['display_name','network_address','rdp_address','api_address'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]]))})});
 if(!r.ok)throw new Error('Enrollment failed for '+n.id+': HTTP '+r.status+'; previously created identities are retained. Do not rotate their tokens implicitly.');
 const enrollment=await r.json();
 const project=n.project_path||'C:/script_factory';
 const config={central_url:base,node_id:n.id,un_id:n.un_id,token:enrollment.token,api_url:n.api_url||'http://127.0.0.1:33001',project_path:project,env_file:n.env_file||project+'/.env',worker_task_name:n.worker_task_name||'ScriptFactory-Test-UN',worker_task_path:n.worker_task_path||'\\',backup_root:n.backup_root||'C:/ScriptFactory-backups',data_dir:'C:/ProgramData/ScriptFactoryAgent/data',release_public_key:'C:/ProgramData/ScriptFactoryAgent/release-public.pem',poll_seconds:30};
 await writeFile(path.join(out,n.id+'.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('Enrolled '+n.id+'; token saved to the protected enrollment file');
}
