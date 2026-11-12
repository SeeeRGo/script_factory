import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {privateDirectory,serviceUrl,identifier} from '../fleet/common.mjs';
const args=process.argv.slice(2),command=args.shift();
const arg=name=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1])throw new Error('Missing --'+name);return args[i+1];};
if(command==='keygen'){
 const file=path.resolve(arg('out'));await privateDirectory(path.dirname(file));await writeFile(file,randomBytes(32),{flag:'wx',mode:0o600});console.log('Master key created; store it separately from the database and back up securely.');
}else if(command==='bootstrap'){
 const base=serviceUrl(arg('url')),ids=arg('nodes').split(','),out=path.resolve(arg('out')),token=process.env.FLEET_ADMIN_TOKEN;
 if(!token||ids.some(id=>!identifier(id)))throw new Error('Set FLEET_ADMIN_TOKEN and valid node ids');
 await privateDirectory(out);
 const r=await fetch(base+'/api/config/bootstrap',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({node_ids:ids,confirm_sensitive_export:true})});
 if(!r.ok)throw new Error('Bootstrap export failed: HTTP '+r.status);
 const bundle=await r.json();
 await writeFile(path.join(out,'fleet-bootstrap.json'),JSON.stringify(bundle,null,2)+'\n',{flag:'wx',mode:0o600});
 for(const node of bundle.nodes){await writeFile(path.join(out,node.node_id+'.env'),node.common_env,{flag:'wx',mode:0o600});const {common_env,...metadata}=node;await writeFile(path.join(out,node.node_id+'.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});}
 console.log('Bootstrap files written to the protected directory; credentials were not displayed.');
}else throw new Error('Usage: fleet-config.mjs keygen --out KEYFILE | bootstrap --url HTTPS_URL --nodes id1,id2 --out DIRECTORY');
