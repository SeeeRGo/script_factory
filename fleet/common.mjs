import { createHash, verify, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile,mkdir,chmod,open } from 'node:fs/promises';
export const fault=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
export const textIdentity=value=>typeof value==='string'&&value.length<=200&&value.trim().length>0&&!/[\x00-\x1f]/.test(value);
export const version=value=>typeof value==='string'&&value.length<=32&&/^\d+\.\d+\.\d+$/.test(value)&&value.split('.').every(p=>Number.isSafeInteger(Number(p)));
export function compareVersion(a,b){if(!version(a)||!version(b))throw fault('INVALID_VERSION','Expected semver x.y.z');for(let i=0;i<3;i++){const d=Number(a.split('.')[i])-Number(b.split('.')[i]);if(d)return Math.sign(d);}return 0;}
export function releaseBytes(m){return Buffer.from(JSON.stringify(['script-factory-release-v1',m.id,m.version,m.release_date,m.commit,m.sha256,m.size_bytes,m.min_api_version,m.node_major,m.database_schema]));}
export function validateRelease(envelope,publicKey){
 const m=envelope?.manifest;
 if(!m||!identifier(m.id)||!version(m.version)||!version(m.min_api_version)||!/^\d{2}\.\d{2}\.\d{4}$/.test(m.release_date)||!/^[a-f0-9]{40,64}$/.test(m.commit)||!/^[a-f0-9]{64}$/.test(m.sha256)||!Number.isSafeInteger(m.size_bytes)||m.size_bytes<1||m.size_bytes>1024**3||m.node_major!==24||m.database_schema!=='unchanged'||typeof envelope.signature!=='string')throw fault('INVALID_RELEASE','Invalid or unsupported release manifest');
 if(!verify(null,releaseBytes(m),publicKey,Buffer.from(envelope.signature,'base64')))throw fault('INVALID_SIGNATURE','Release signature is not trusted');
 if(compareVersion(m.version,m.min_api_version)<0)throw fault('INVALID_RELEASE','Release version is below minimum API');
 return m;
}
export function serviceUrl(value,{local=false}={}){
 let u;try{u=new URL(value);}catch{throw fault('INVALID_URL','Expected absolute service URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||(!['https:','http:'].includes(u.protocol))||(u.protocol==='http:'&&!loopback)||(local&&!loopback))throw fault('INVALID_URL','HTTPS required; HTTP is permitted only on loopback. Use root URL without credentials');
 return u.origin;
}
export async function atomicJson(file,value){
 const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flush:true});await rename(tmp,file);
 const {dirname}=await import('node:path');const handle=await open(process.platform==='win32'?file:dirname(file),process.platform==='win32'?'r+':'r');
 try{await handle.sync();}finally{await handle.close();}
}
export async function optionalJson(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function privateDirectory(dir){
 await mkdir(dir,{recursive:true,mode:0o700});
 if(process.platform!=='win32'){await chmod(dir,0o700);return;}
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const encoded=Buffer.from(dir,'utf8').toString('base64');
 const ps=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($me);foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')){$id=New-Object Security.Principal.SecurityIdentifier($sid);$rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};Set-Acl -LiteralPath $p -AclObject $acl`;
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{windowsHide:true});
}
