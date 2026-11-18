import { readFile,writeFile,readdir,open,unlink } from 'node:fs/promises';
import path from 'node:path';
import { serviceUrl,identifier,textIdentity,privateDirectory,atomicJson } from '../fleet/common.mjs';
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1])throw new Error('Не задан --'+name);return args[i+1];};
const redact=value=>String(value).replaceAll(process.env.FLEET_ADMIN_TOKEN||'\0','[скрыто]').replace(/[\r\n]+/g,' ').slice(0,1500);
async function responseJson(response,label){
 const text=await response.text();let body;try{body=JSON.parse(text);}catch{}
 if(!response.ok){
  const reason=body?.error?.message||text.slice(0,400)||response.statusText;
  throw new Error(`${label}: HTTP ${response.status}${body?.error?.code?' / '+body.error.code:''}: ${reason}`);
 }
 if(!body||typeof body!=='object')throw new Error(label+': сервер вернул некорректный JSON');
 return body;
}
async function main(){
 const base=serviceUrl(arg('url')),out=path.resolve(arg('out')),inventory=path.resolve(arg('inventory'));
 let nodes;
 try{nodes=JSON.parse(await readFile(inventory,'utf8'));}
 catch(error){if(error.code==='ENOENT')throw new Error(`Не найден ${inventory}. Если исходный список — nodes.csv (Computer,EnvFile), сначала выполните windows/convert-fleet-inventory.ps1.`);throw new Error(`Не удалось прочитать JSON-инвентарь ${inventory}: ${error.message}`);}
 if(!process.env.FLEET_ADMIN_TOKEN)throw new Error('Задайте FLEET_ADMIN_TOKEN — токен администратора центра, а не ключ API отдельной УН');
 if(!Array.isArray(nodes)||!nodes.length)throw new Error('JSON-инвентарь должен содержать непустой массив УН');
 const ids=new Set(),unIds=new Set();
 for(const node of nodes){
  if(!node||!identifier(node.id)||!textIdentity(node.un_id))throw new Error('Некорректные id/un_id в JSON-инвентаре');
  if(ids.has(node.id)||unIds.has(node.un_id))throw new Error(`В инвентаре повторяется id или UN_ID: ${node.id} / ${node.un_id}`);
  ids.add(node.id);unIds.add(node.un_id);
 }
 let response;
 try{response=await fetch(base+'/api/fleet',{headers:{Authorization:'Bearer '+process.env.FLEET_ADMIN_TOKEN},redirect:'error'});}
 catch(error){throw new Error(`Не удалось обратиться к ${base}: ${error.cause?.code||error.message}`);}
 const snapshot=await responseJson(response,'Проверка доступа к центру');
 const registered=Object.values(snapshot.nodes||{});
 const local=[];
 try{for(const name of await readdir(out)){if(!name.endsWith('.json'))continue;const file=path.join(out,name);let config;try{config=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('Не удалось прочитать конфигурацию '+file);}
  if(config.node_id&&config.un_id&&config.token)local.push({file,config});
 }}catch(error){if(error.code!=='ENOENT')throw error;}
 const recover=args.includes('--recover-existing'),dry=args.includes('--dry-run'),plan=[];
 const request=(url,options={})=>fetch(base+url,{redirect:'error',signal:AbortSignal.timeout(15000),...options});
 for(const node of nodes){
  const byId=registered.find(n=>n.id===node.id),existing=registered.find(n=>n.un_id===node.un_id);
  if(byId&&byId.un_id!==node.un_id)throw new Error('Регистрация не началась: id '+node.id+' принадлежит другому UN_ID');
  const id=existing?.id||node.id,candidates=local.filter(c=>c.config.node_id===id&&c.config.un_id===node.un_id);
  if(candidates.length>1)throw new Error('Несколько конфигураций для '+id+': оставьте одну действующую в каталоге вывода');
  const saved=candidates[0];let valid=false;
  if(existing&&!existing.revoked&&saved){
   const response=await request('/agent/'+id+'/packages/enrollment-probe',{headers:{Authorization:'Bearer '+saved.config.token}});
   const body=await response.json().catch(()=>null);
   valid=response.status===403&&body?.error?.code==='PACKAGE_DENIED';
   if(!valid&&response.status!==401)throw new Error('Не удалось проверить ключ '+id+': HTTP '+response.status);
  }
  if(!saved){try{await readFile(path.join(out,id+'.json'));throw new Error('Файл вывода занят: '+id+'.json');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const action=!existing?'create':valid?'reuse':recover?'recover':'blocked';
  plan.push({node,id,existing,saved,action});
  console.log(id+' / '+node.un_id+': '+action+(existing?.revoked?' (ключ отозван)':''));
 }
 if(dry)return;
 if(plan.some(p=>p.action==='blocked'))throw new Error('Регистрация не началась: нет действующей локальной конфигурации. Для восстановления потерянных/отозванных ключей повторите с --recover-existing. Установленным агентам затем передайте обновлённый JSON.');
 await privateDirectory(out);
 const lockFile=path.join(out,'.enrollment.lock');let lock;
 try{lock=await open(lockFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('Другой запуск или незавершённая операция: '+lockFile+'. Проверьте процессы перед удалением блокировки.');throw error;}
 try{
  // Recheck under the lock: a simultaneous run may have changed the center.
  const current=await responseJson(await request('/api/fleet',{headers:{Authorization:'Bearer '+process.env.FLEET_ADMIN_TOKEN}}),'Повторная проверка центра');
  for(const p of plan){const now=Object.values(current.nodes||{}).find(n=>n.id===p.id||n.un_id===p.node.un_id);if(JSON.stringify(now)!==JSON.stringify(p.existing))throw new Error('Состояние центра изменилось для '+p.id+'. Повторите запуск.');}
  for(const {node,id,existing,saved,action} of plan){
   let token=saved?.config.token;
   if(action!=='reuse'){
    const payload={id,un_id:node.un_id,group:node.group||'default',...Object.fromEntries(['display_name','network_address','rdp_address','api_address'].filter(k=>node[k]!==undefined).map(k=>[k,node[k]]))};
    const result=await responseJson(await request(existing?'/api/nodes/'+id+'/rotate':'/api/nodes',{method:'POST',headers:{Authorization:'Bearer '+process.env.FLEET_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(payload)}),'Регистрация '+id);
    token=result.token;
   }
   const project=node.project_path||saved?.config.project_path||'C:/script_factory';
   const config={central_url:base,node_id:id,un_id:node.un_id,token,api_url:'http://127.0.0.1:33001',project_path:project,env_file:project+'/.env',worker_task_name:'ScriptFactory-Test-UN',worker_task_path:'\\',backup_root:'C:/ScriptFactory-backups',data_dir:'C:/ProgramData/ScriptFactoryAgent/data',release_public_key:'C:/ProgramData/ScriptFactoryAgent/release-public.pem',poll_seconds:30,...saved?.config};
   for(const key of ['api_url','project_path','env_file','worker_task_name','worker_task_path','backup_root','data_dir','release_public_key','poll_seconds'])if(node[key]!==undefined)config[key]=node[key];
   Object.assign(config,{central_url:base,node_id:id,un_id:node.un_id,token});
   const file=saved?.file||path.join(out,id+'.json');
   if(!saved){try{await readFile(file);throw new Error('Файл уже существует и не является конфигурацией агента: '+file);}catch(error){if(error.code!=='ENOENT')throw error;}}
   if(saved&&JSON.stringify(config)!==JSON.stringify(saved.config))await writeFile(file+'.bak',JSON.stringify(saved.config,null,2)+'\n',{mode:0o600});
   await atomicJson(file,config);
   console.log('Готово '+id+': '+file+'; ключ не выводится');
  }
 }finally{await lock.close();await unlink(lockFile);}

}
// Windows PowerShell 5.1 + ErrorActionPreference=Stop can hide native stderr
// before the useful line. Print the concise reason to stdout before exiting.
main().catch(error=>{console.log('Ошибка регистрации: '+redact(error.message));process.exitCode=1;});
