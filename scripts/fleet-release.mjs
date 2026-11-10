import { generateKeyPairSync,sign,createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir,access,unlink } from 'node:fs/promises';
import path from 'node:path';
import { hash,releaseBytes,validateRelease,serviceUrl,privateDirectory } from '../fleet/common.mjs';
const args=process.argv.slice(2),command=args.shift();
function arg(name,required=true){const i=args.indexOf('--'+name);if(i>=0&&args[i+1])return args[i+1];if(required)throw new Error('Missing --'+name);}
if(command==='keygen'){
 const out=path.resolve(arg('out'));await privateDirectory(out);
 for(const name of ['release-private.pem','release-public.pem']){try{await access(path.join(out,name));throw new Error('Signing key files already exist; choose another directory');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const pair=generateKeyPairSync('ed25519');
 await writeFile(path.join(out,'release-private.pem'),pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
 try{await writeFile(path.join(out,'release-public.pem'),pair.publicKey.export({format:'pem',type:'spki'}),{flag:'wx'});}catch(e){await unlink(path.join(out,'release-private.pem'));throw e;}
 console.log('Release signing keys created. Keep release-private.pem outside the repository and the fleet server.');
}else if(command==='build'){
 const ref=arg('ref'),out=path.resolve(arg('out')),key=await readFile(arg('key'),'utf8');
 const commit=execFileSync('git',['rev-parse','--verify',ref+'^{commit}'],{encoding:'utf8'}).trim();
 const pkg=JSON.parse(execFileSync('git',['show',commit+':package.json'],{encoding:'utf8'}));
 const id=pkg.version.replaceAll('.','_')+'-'+commit.slice(0,12);await mkdir(out,{recursive:true});
 const archive=path.join(out,id+'.zip');
 // Filter tracked files as well: an accidentally force-added configuration must not enter a release.
 const tree=execFileSync('git',['ls-tree','-r','-z',commit],{encoding:'utf8'}).split('\0').filter(Boolean);
 const roots=new Set(['package.json','package-lock.json','openapi.yaml','.env.example','docs/project-guide/tools/update-one-un.ps1']);
 const templates=new Set(['.env.example','windows/.env.example','fleet/controller.env.example','fleet/agent.config.example.json','fleet/nodes.example.json']);
 const files=tree.flatMap(entry=>{
  const [info,name]=entry.split('\t');
  if(!roots.has(name)&&!['src/','public/','windows/','fleet/'].some(p=>name.startsWith(p)))return [];
  if(!templates.has(name)&&(/(^|\/)(?:\.env[^/]*|agent\.config\.json|controller\.env|(?:data|work|outputs|node_modules)(?:\/|$))/.test(name)||/\.(?:pem|key|pfx|p12|zip|sqlite|xml)$/i.test(name)||/\.env(?:\.|$)/.test(name)))return [];
  if(!['100644','100755'].includes(info.split(' ')[0]))throw new Error('Release source must not contain symlinks: '+name);
  return [name];
 });
 execFileSync('git',['--literal-pathspecs','archive','--format=zip','--output='+archive,commit,...files]);
 const bytes=await readFile(archive);
 const manifest={id,version:pkg.version,release_date:pkg.releaseDate,commit,sha256:hash(bytes),size_bytes:bytes.length,min_api_version:'0.11.0',node_major:24,database_schema:'unchanged'};
 const envelope={manifest,signature:sign(null,releaseBytes(manifest),key).toString('base64')};
 validateRelease(envelope,createPublicKey(key));
 await writeFile(path.join(out,id+'.json'),JSON.stringify(envelope,null,2)+'\n');
 console.log(JSON.stringify({id,version:pkg.version,archive,sha256:manifest.sha256}));
}else if(command==='publish'){
 const base=serviceUrl(arg('url')),envelope=JSON.parse(await readFile(arg('manifest'),'utf8')),token=process.env.FLEET_ADMIN_TOKEN;
 if(!token)throw new Error('Set FLEET_ADMIN_TOKEN in the environment');
 const snapshotResponse=await fetch(base+'/api/fleet',{headers:{Authorization:'Bearer '+token},redirect:'error'});
 if(!snapshotResponse.ok)throw new Error('Controller access failed: HTTP '+snapshotResponse.status);
 const existing=(await snapshotResponse.json()).releases[envelope.manifest.id];
 if(existing&&(existing.signature!==envelope.signature||existing.manifest.sha256!==envelope.manifest.sha256))throw new Error('Release id conflicts with an existing immutable package');
 const operations=[];
 if(!existing)operations.push(['/api/releases','POST',JSON.stringify(envelope),'application/json']);
 if(!existing?.ready)operations.push(['/api/releases/'+envelope.manifest.id+'/package','PUT',await readFile(arg('zip')),'application/zip']);
 for(const [route,method,body,type] of operations){
  const r=await fetch(base+route,{method,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':type},body});
  if(!r.ok)throw new Error('Publish failed: HTTP '+r.status);
 }
 console.log(existing?.ready?'Release is already published':'Release registered and uploaded');
}else{throw new Error('Usage: fleet-release.mjs keygen|build|publish; see docs/project-guide/11-fleet-updates.md');}
