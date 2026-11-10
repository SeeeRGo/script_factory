import net from 'node:net';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
export const workerError=(code,message,retryable=false)=>Object.assign(new Error(message),{code,retryable,statusCode:503});
const digest=s=>createHash('sha256').update(String(s)).digest();
export function workerSettings(env=process.env){
  const mode=env.EXECUTION_MODE||'inline';if(!['inline','broker'].includes(mode))throw new Error('EXECUTION_MODE must be inline or broker');
  const settings={mode,port:Number(env.WORKER_PORT||Number(env.PORT||3000)+1),token:env.WORKER_AUTH_TOKEN||'',account:env.WORKER_ACCOUNT||'',heartbeatMs:Number(env.WORKER_HEARTBEAT_MS||3000),lostMs:Number(env.WORKER_LOST_MS||15000),cancelMs:Number(env.WORKER_CANCEL_MS||10000),startupMs:Number(env.WORKER_STARTUP_MS||120000),maxBytes:Number(env.WORKER_MAX_MESSAGE_BYTES||16777216)};
  if(mode==='broker'&&(settings.token.length<32||settings.token.startsWith('REPLACE_')||!Number.isInteger(settings.port)||settings.port<1||settings.port>65535||!settings.account))throw new Error('Set WORKER_AUTH_TOKEN (32+ chars), WORKER_ACCOUNT and valid WORKER_PORT');
  for(const key of ['heartbeatMs','lostMs','cancelMs','startupMs','maxBytes'])if(!Number.isSafeInteger(settings[key])||settings[key]<1||settings[key]>2147483647)throw new Error('Invalid worker transport limit: '+key);
  if(settings.lostMs<settings.heartbeatMs*2||settings.maxBytes<1048576)throw new Error('Worker limits are inconsistent');
  return settings;
}
export function channel(socket,{onMessage,onClose,maxBytes=16777216}){
  let buffer='',closed=false;
  socket.setEncoding('utf8');socket.setNoDelay(true);
  socket.on('data',part=>{buffer+=part;if(Buffer.byteLength(buffer)>maxBytes){socket.destroy();return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{onMessage(JSON.parse(line));}catch{socket.destroy();return;}}});
  socket.on('error',()=>{});socket.once('close',()=>{closed=true;onClose?.();});
  return {send(value){if(closed||socket.destroyed)return false;const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>maxBytes){socket.destroy();return false;}return socket.write(text);},close(){socket.destroy();},get closed(){return closed||socket.destroyed;}};
}
export function createWorkerBroker({settings,version,onReady=()=>{},onIdle=()=>{},onConnected=()=>{},isCommitted=()=>false}){
  let connection=null,hello=null,lastBeat=0,transportError=null,stopping=false,sessionPresent=null,sessionSince=Date.now(),boot=Date.now();
  const pending=new Map(),sockets=new Set();
  const snapshot=()=>{
    let code=null,retryable=true;
    if(transportError){code='WORKER_TRANSPORT_FAILED';retryable=false;}
    else if(!connection){const elapsed=Date.now()-(sessionPresent?sessionSince:boot);code=sessionPresent===false?'WAITING_FOR_SESSION':'WORKER_STARTING';if(elapsed>=settings.startupMs){code=sessionPresent===false?'WORKER_SESSION_REQUIRED':'WORKER_START_FAILED';retryable=false;}}
    else if(!hello.ready){code='WORKER_START_FAILED';retryable=false;}
    else if([...pending.values()].some(p=>p.uncertain)){code='WORKER_UNRESPONSIVE';retryable=false;}
    const messages={READY:'Исполнитель готов',WAITING_FOR_SESSION:'Ожидается вход пользователя worker в Windows',WORKER_STARTING:'Ожидается запуск исполнителя',WORKER_SESSION_REQUIRED:'Автоматический вход не завершён; требуется вход пользователя worker',WORKER_START_FAILED:'Исполнитель не запущен или браузер не готов; проверьте задачу и журнал',WORKER_UNRESPONSIVE:'Остановка текущего выполнения не подтверждена',WORKER_TRANSPORT_FAILED:'Локальный канал исполнителя недоступен'};
    return {mode:'broker',connected:!!connection,ready:!code,state:code||'READY',message:messages[code||'READY'],retryable:code?retryable:false,retry_after_ms:code&&retryable?2000:null,account:hello?.account||settings.account,session_id:hello?.session_id??null,pid:hello?.pid??null,capacity:hello?.capacity||0,active:pending.size,browser:hello?.browser||null};
  };
  function complete(message){
    const p=pending.get(message.execution_id);if(!p)return;
    if(message.job_id!==p.jobId){connection?.close();return;}
    p.finished=true;clearTimeout(p.cancelTimer);
    if(!p.settled){p.settled=true;if(message.error){const e=Object.assign(workerError(message.error.code||'WORKER_ERROR',message.error.message||'Ошибка исполнителя',message.error.retryable===true),message.error);p.reject(e);}else p.resolve(message.result);}
    if(p.acknowledged){connection?.send({type:'ack',execution_id:message.execution_id});pending.delete(message.execution_id);onIdle();}
  }
  const server=net.createServer(socket=>{
    sockets.add(socket);let authenticated=false,ch;
    const timer=setTimeout(()=>socket.destroy(),5000);
    ch=channel(socket,{maxBytes:settings.maxBytes,onMessage:m=>{
      if(!authenticated){
        if(m.type!=='hello'||m.protocol!==1||!timingSafeEqual(digest(m.token),digest(settings.token))||m.version!==version||String(m.account).toLowerCase()!==settings.account.toLowerCase()||!Number.isInteger(m.capacity)||m.capacity<1||m.capacity>100||!Number.isInteger(m.session_id)||m.session_id<0||(process.platform==='win32'&&m.session_id===0)||connection){ch.close();return;}
        authenticated=true;clearTimeout(timer);connection=ch;hello={account:m.account,session_id:m.session_id,pid:m.pid,capacity:m.capacity,ready:m.ready===true,browser:m.browser||null};lastBeat=Date.now();
        ch.send({type:'accepted'});
        for(const id of (m.outcomes||[]).slice(0,1000))if(typeof id==='string'){if(pending.has(id))ch.send({type:'recover',execution_id:id});else if(isCommitted(id))ch.send({type:'ack',execution_id:id});}
        onConnected();onReady();return;
      }
      lastBeat=Date.now();
      if(m.type==='heartbeat'){hello.ready=m.ready===true;if(m.browser)hello.browser=m.browser;ch.send({type:'pong'});}
      else if(m.type==='event'){const p=pending.get(m.execution_id);if(p&&!p.settled)p.onEvent(m.event);}
      else if(m.type==='log'){const p=pending.get(m.execution_id);if(p&&!p.settled&&['debug','info','warn','error'].includes(m.level))p.onLog(m.level,String(m.message).slice(0,20000));}
      else if(m.type==='complete')complete(m);
    },onClose:()=>{clearTimeout(timer);sockets.delete(socket);if(connection===ch){connection=null;hello=null;for(const p of pending.values()){p.uncertain=true;if(!p.settled){p.settled=true;p.reject(workerError('WORKER_EXECUTION_UNCERTAIN','Связь с исполнителем потеряна; исход действий требует сверки'));}}onIdle();}}});
  });
  const watch=setInterval(()=>{if(connection&&Date.now()-lastBeat>settings.lostMs)connection.close();},settings.heartbeatMs);watch.unref();
  return {
    snapshot,get active(){return pending.size;},get availableSlots(){return snapshot().ready?Math.max(0,hello.capacity-pending.size):0;},
    finished(id){return pending.get(id)?.finished===true;},
    has(id){return pending.has(id);},
    setSessionPresent(value){if(value!==sessionPresent){sessionPresent=value;sessionSince=Date.now();}},
    async listen(){await new Promise(resolve=>{server.once('error',e=>{transportError=e.code||'TRANSPORT_ERROR';resolve();});server.listen(settings.port,'127.0.0.1',resolve);});},
    execute({executionId=randomUUID(),jobId,options,signal,onEvent=()=>{},onLog=()=>{}}){
      if(!this.availableSlots||stopping)throw workerError('WORKER_UNAVAILABLE','Исполнитель не готов');
      return new Promise((resolve,reject)=>{
        const p={jobId,resolve,reject,onEvent,onLog,finished:false,settled:false,uncertain:false,acknowledged:false};pending.set(executionId,p);
        const abort=()=>{connection?.send({type:'cancel',execution_id:executionId,reason:{code:signal.reason?.code||'CANCELLED',message:signal.reason?.message||'Задание отменено'}});p.cancelTimer=setTimeout(()=>{if(!p.settled){p.settled=true;p.uncertain=true;reject(signal.reason||workerError('WORKER_EXECUTION_UNCERTAIN','Остановка исполнителя не подтверждена'));}},settings.cancelMs);};
        signal?.addEventListener('abort',abort,{once:true});p.dispose=()=>signal?.removeEventListener('abort',abort);
        connection.send({type:'execute',execution_id:executionId,job_id:jobId,options});if(signal?.aborted)abort();
      });
    },
    ack(id){const p=pending.get(id);if(!p)return;p.acknowledged=true;p.dispose?.();if(p.finished){connection?.send({type:'ack',execution_id:id});pending.delete(id);onIdle();}},
    // A fresh connection is accepted only after the worker has stopped old executions.
    clearDisconnected(){for(const [id,p] of pending)if(p.settled&&p.uncertain){clearTimeout(p.cancelTimer);p.dispose?.();pending.delete(id);}},
    async close(){stopping=true;clearInterval(watch);for(const p of pending.values()){clearTimeout(p.cancelTimer);p.dispose?.();if(!p.settled)p.reject(workerError('WORKER_EXECUTION_UNCERTAIN','API остановлено; исход задания требует сверки'));}for(const s of sockets)s.destroy();if(server.listening)await new Promise(r=>server.close(r));}
  };
}
