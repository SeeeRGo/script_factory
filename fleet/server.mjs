import http from 'node:http';
import { mkdir,readFile,open,rename,unlink,stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFleetStore } from './store.mjs';
import { equal,fault,hash,validateRelease } from './common.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function createFleetServer({dataDir,adminToken,publicKey,maxConcurrent=10,maxPackageBytes=512*1024**2}){
 if(typeof adminToken!=='string'||adminToken.length<32||adminToken.startsWith('REPLACE_'))throw new Error('Set a real FLEET_ADMIN_TOKEN with at least 32 characters');
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>300)throw new Error('Invalid FLEET_MAX_CONCURRENT');
 await mkdir(path.join(dataDir,'packages'),{recursive:true,mode:0o700});
 const store=openFleetStore(path.join(dataDir,'fleet.sqlite'),{maxConcurrent});
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 async function json(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>128*1024)throw fault('BODY_TOO_LARGE','JSON is too large',413);parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw fault('INVALID_JSON','Expected JSON');}}
 function admin(req,res){const auth=req.headers.authorization||'';let token=auth.startsWith('Bearer ')?auth.slice(7):'';if(auth.startsWith('Basic ')){const pair=Buffer.from(auth.slice(6),'base64').toString('utf8');if(pair.startsWith('admin:'))token=pair.slice(6);}if(!equal(hash(token),hash(adminToken))){res.setHeader('WWW-Authenticate','Basic realm="Script Factory Fleet"');throw fault('UNAUTHORIZED','Admin authentication required',401);}}
 function agent(req,id){const n=store.node(id);const token=(req.headers.authorization||'').replace(/^Bearer /,'');if(!n||!equal(hash(token),n.token_hash))throw fault('UNAUTHORIZED','Agent authentication failed',401);}
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),method=req.method;
  try{
   if(url.pathname==='/health'&&method==='GET'){send(res,200,{status:'ok',service:'script-factory-fleet',protocol:1});return;}
   const a=/^\/agent\/([A-Za-z0-9_-]+)\/(heartbeat|reports|packages)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
   if(a){
    agent(req,a[1]);
    if(method==='POST'&&a[2]==='heartbeat'&&!a[3]){send(res,200,store.heartbeat(a[1],await json(req)));return;}
    if(method==='POST'&&a[2]==='reports'&&a[3]){send(res,200,store.report(a[1],a[3],await json(req)));return;}
    if(method==='GET'&&a[2]==='packages'&&a[3]){
     if(!store.mayDownload(a[1],a[3]))throw fault('PACKAGE_DENIED','No active assignment for this package',403);
     const file=path.join(dataDir,'packages',a[3]+'.zip');const info=await stat(file);
     res.writeHead(200,{'Content-Type':'application/zip','Content-Length':info.size,'Cache-Control':'no-store'});await pipeline(createReadStream(file),res);return;
    }
    throw fault('NOT_FOUND','Agent method not found',404);
   }
   admin(req,res);
   if(!['GET','HEAD'].includes(method)){
    if(req.headers['sec-fetch-site']==='cross-site')throw fault('ORIGIN_DENIED','Cross-site writes forbidden',403);
    if(req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)throw fault('ORIGIN_DENIED','Cross-origin writes forbidden',403);}
    if(!String(req.headers['content-type']||'').startsWith(url.pathname.endsWith('/package')?'application/zip':'application/json'))throw fault('INVALID_CONTENT_TYPE','JSON or ZIP content type required',415);
   }
   if(method==='GET'&&['/','/fleet-ui.js'].includes(url.pathname)){
    res.writeHead(200,{'Content-Type':url.pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});res.end(await readFile(path.join(here,url.pathname==='/'?'index.html':'fleet-ui.js')));return;
   }
   if(method==='GET'&&url.pathname==='/api/fleet'){send(res,200,store.overview());return;}
   if(method==='POST'&&url.pathname==='/api/nodes'){send(res,201,store.addNode(await json(req)));return;}
   const credential=/^\/api\/nodes\/([A-Za-z0-9_-]+)\/(revoke|rotate)$/.exec(url.pathname);
   if(method==='POST'&&credential){await json(req);send(res,200,store.credential(credential[1],credential[2]));return;}
   if(method==='POST'&&url.pathname==='/api/releases'){const body=await json(req);validateRelease(body,publicKey);if(body.manifest.size_bytes>maxPackageBytes)throw fault('PACKAGE_TOO_LARGE','Package exceeds configured maximum',413);send(res,201,store.addRelease(body));return;}
   const upload=/^\/api\/releases\/([A-Za-z0-9_-]+)\/package$/.exec(url.pathname);
   if(method==='PUT'&&upload){
    const id=upload[1],release=store.read().releases[id];if(!release||release.ready)throw fault('INVALID_RELEASE','Release not registered or already immutable',409);
    const file=path.join(dataDir,'packages',id+'.zip'),temp=file+'.'+randomUUID()+'.tmp';let handle;
    try{
     handle=await open(temp,'wx',0o600);const sum=createHash('sha256');let size=0;
     for await(const part of req){size+=part.length;if(size>release.manifest.size_bytes||size>maxPackageBytes)throw fault('PACKAGE_TOO_LARGE','Package length exceeds manifest',413);sum.update(part);await handle.writeFile(part);}
     await handle.close();handle=null;
     if(size!==release.manifest.size_bytes||sum.digest('hex')!==release.manifest.sha256)throw fault('PACKAGE_MISMATCH','Package checksum or length mismatch');
     await rename(temp,file);send(res,200,store.readyRelease(id));return;
    }finally{await handle?.close();await unlink(temp).catch(()=>{});}
   }
   if(method==='POST'&&url.pathname==='/api/rollouts'){send(res,201,store.rollout(await json(req)));return;}
   const control=/^\/api\/rollouts\/([A-Za-z0-9_-]+)\/(pause|resume|cancel)$/.exec(url.pathname);
   if(method==='POST'&&control){await json(req);send(res,200,store.control(control[1],control[2]));return;}
   const retry=/^\/api\/deployments\/([A-Za-z0-9_-]+)\/retry$/.exec(url.pathname);
   if(method==='POST'&&retry){await json(req);send(res,200,store.retry(retry[1]));return;}
   const resolve=/^\/api\/deployments\/([A-Za-z0-9_-]+)\/resolve$/.exec(url.pathname);
   if(method==='POST'&&resolve){send(res,200,store.resolve(resolve[1],await json(req)));return;}
   throw fault('NOT_FOUND','Route not found',404);
  }catch(e){if(!e.statusCode)console.error('Fleet request failed:',e.code||'INTERNAL_ERROR');if(res.headersSent){res.destroy();return;}send(res,e.statusCode||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.statusCode?e.message:'Operation failed; inspect the local service'}});}
 });
 server.requestTimeout=300000;server.headersTimeout=15000;
 server.on('close',()=>store.close());
 return {server,store};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {server}=await createFleetServer({dataDir:path.resolve(process.env.FLEET_DATA_DIR||'fleet-data'),adminToken:process.env.FLEET_ADMIN_TOKEN,publicKey:await readFile(process.env.FLEET_RELEASE_PUBLIC_KEY,'utf8'),maxConcurrent:Number(process.env.FLEET_MAX_CONCURRENT||10)});
 server.listen(Number(process.env.FLEET_PORT||34001),process.env.FLEET_HOST||'127.0.0.1',()=>console.log('Script Factory Fleet listening'));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close());
}
