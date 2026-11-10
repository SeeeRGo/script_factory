import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readdir,readFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {workerSettings,channel,workerError} from './worker-transport.js';
import {runJobRuntime} from './job-runtime.js';
import {resolveBrowserSettings} from './browser-settings.js';
import {resolveBrowserExecutablePath} from './browser-replay.js';
import {atomicJson} from '../fleet/common.mjs';
import {detectYandexVersion} from './system-checks.js';
const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
export async function startBrowserWorker({env=process.env,run=runJobRuntime,onDiagnostic=()=>{}}={}){
  const settings=workerSettings(env);if(settings.mode!=='broker')throw new Error('Browser worker requires EXECUTION_MODE=broker');
  const dataDir=path.resolve(env.DATA_DIR||'data'),journal=path.join(dataDir,'worker-state'),artifactRoot=path.join(dataDir,'artifacts');await mkdir(journal,{recursive:true});
  const account=env.USERDOMAIN?`${env.USERDOMAIN}\\${os.userInfo().username}`:os.userInfo().username;
  const session=Number(env.WORKER_SESSION_ID||0),capacity=Number(env.WORKER_MAX_PARALLEL_JOBS||100);
  if(process.platform==='win32'&&session<=0)throw new Error('Browser worker requires an interactive session');
  if(account.toLowerCase()!==settings.account.toLowerCase()||!Number.isInteger(capacity)||capacity<1||capacity>100)throw new Error('Worker account or capacity does not match configuration');
  let stopped=false,current=null,accepted=false,heartbeat=null,ready=false,browserInfo=null;
  const running=new Map(),outcomes=new Set();
  for(const name of await readdir(journal)){if(!name.endsWith('.json')||!validId(name.slice(0,-5)))continue;const record=JSON.parse(await readFile(path.join(journal,name),'utf8'));
    if(record.phase==='running'){record.phase='finished';record.error={code:'WORKER_EXECUTION_UNCERTAIN',message:'Предыдущий процесс исполнителя завершился; исход действий требует сверки',retryable:false};await atomicJson(path.join(journal,name),record);}outcomes.add(name.slice(0,-5));}
  async function probe(){try{const defaults=resolveBrowserSettings();const executable=await resolveBrowserExecutablePath(defaults.executable_path);ready=!!executable;browserInfo={status:ready?'ok':'error',executable_path:executable||null,headless:defaults.headless,yandex_version:await detectYandexVersion()};}catch{ready=false;browserInfo={status:'error',executable_path:null};}}
  await probe();
  const frame=(type,extra={})=>current?.send({type,...extra});
  const journalPath=id=>path.join(journal,id+'.json');
  async function sendOutcome(id){if(!validId(id)||!outcomes.has(id))return;const record=JSON.parse(await readFile(journalPath(id),'utf8'));if(record.phase==='finished')frame('complete',{execution_id:id,job_id:record.job_id,result:record.result,error:record.error});}
  async function execute(message){
    const id=message.execution_id,jobId=message.job_id;
    if(!validId(id)||!validId(jobId)||!message.options||running.has(id)||outcomes.has(id)||running.size>=capacity){current?.close();return;}
    const expected=path.join(artifactRoot,jobId);
    if(path.resolve(message.options.artifactDirectory)!==expected){current?.close();return;}
    const controller=new AbortController();
    const task=(async()=>{
      const record={execution_id:id,job_id:jobId,phase:'running',instance_id:instance};
      await atomicJson(journalPath(id),record);
      try{record.result=await run({...message.options,jobId,signal:controller.signal,onEvent:event=>frame('event',{execution_id:id,event}),onBrowserLog:(level,message)=>frame('log',{execution_id:id,level,message})});}
      catch(error){record.error={code:error.code||'WORKER_ERROR',message:error.message||'Ошибка исполнителя',retryable:error.retryable===true,...(error.details?{details:error.details}:{}),...(error.partial_context?{partial_context:error.partial_context}:{})};}
      record.phase='finished';await atomicJson(journalPath(id),record);outcomes.add(id);await sendOutcome(id);
    })().catch(()=>{onDiagnostic('WORKER_JOURNAL_FAILED');current?.close();}).finally(()=>running.delete(id));
    running.set(id,{controller,task});
  }
  const instance=randomUUID();
  async function loop(){
    while(!stopped){
      accepted=false;
      await new Promise(resolve=>{
        const socket=net.connect({host:'127.0.0.1',port:settings.port});let ch,lastServerBeat=Date.now();
        ch=channel(socket,{maxBytes:settings.maxBytes,onMessage:m=>{
          lastServerBeat=Date.now();
          if(m.type==='accepted'){accepted=true;return;}
          if(!accepted){ch.close();return;}
          if(m.type==='execute')void execute(m);
          else if(m.type==='cancel'){const item=running.get(m.execution_id);item?.controller.abort(workerError(m.reason?.code||'CANCELLED',m.reason?.message||'Задание отменено'));}
          else if(m.type==='recover')void sendOutcome(m.execution_id).catch(()=>ch.close());
          else if(m.type==='ack'&&validId(m.execution_id)&&outcomes.has(m.execution_id)){outcomes.delete(m.execution_id);void unlink(journalPath(m.execution_id)).catch(()=>{});}
        },onClose:()=>{if(current===ch)current=null;resolve();}});
        current=ch;socket.once('connect',()=>ch.send({type:'hello',protocol:1,token:settings.token,version:packageInfo.version,account,session_id:session,pid:process.pid,instance_id:instance,capacity,ready,browser:browserInfo,outcomes:[...outcomes].slice(0,1000)}));
        heartbeat=setInterval(()=>{if(Date.now()-lastServerBeat>settings.lostMs){ch.close();return;}if(accepted)ch.send({type:'heartbeat',ready,browser:browserInfo});},settings.heartbeatMs);heartbeat.unref();
      });
      clearInterval(heartbeat);
      for(const r of running.values())r.controller.abort(workerError('WORKER_EXECUTION_UNCERTAIN','Соединение с API потеряно; проверьте исход действий'));
      const guard=setTimeout(()=>{if(running.size)process.exit(74);},settings.cancelMs);guard.unref();
      await Promise.allSettled([...running.values()].map(r=>r.task));clearTimeout(guard);
      if(!stopped){await delay(1000);await probe();}
    }
  }
  const promise=loop();
  return {promise,async close(){stopped=true;current?.close();for(const r of running.values())r.controller.abort(workerError('CANCELLED','Исполнитель останавливается'));await promise;}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const worker=await startBrowserWorker({onDiagnostic:code=>console.error(code)});
  for(const name of ['SIGTERM','SIGINT'])process.on(name,()=>void worker.close());await worker.promise;
}
