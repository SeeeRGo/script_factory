import { readFile,writeFile,access } from 'node:fs/promises';
import path from 'node:path';
import { serviceUrl,identifier,textIdentity,privateDirectory } from '../fleet/common.mjs';
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
 const conflicts=[];
 for(const node of nodes){
  const existing=registered.find(n=>n.id===node.id||n.un_id===node.un_id);
  if(existing)conflicts.push(`${node.network_address||node.id}: UN_ID=${node.un_id}; в центре id=${existing.id}, UN_ID=${existing.un_id}${existing.revoked?' (ключ отозван)':''}. Используйте существующую запись и её конфигурацию; отзыв ключа не удаляет УН. Если нужен новый ключ, перевыпустите его явно в панели. Исключите эту УН из новой регистрации.`);
 }
 if(conflicts.length)throw new Error('Регистрация не началась: '+conflicts.join(' | '));
 for(const node of nodes){
  const file=path.join(out,node.id+'.json');
  let exists=false;try{await access(file);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists)throw new Error(`Регистрация не началась: ${file} уже существует. Проверьте ранее выданную конфигурацию; файл не перезаписан.`);
 }
 await privateDirectory(out);
 for(const node of nodes){
  let result;
  try{
   const response=await fetch(base+'/api/nodes',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+process.env.FLEET_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({id:node.id,un_id:node.un_id,group:node.group||'default',...Object.fromEntries(['display_name','network_address','rdp_address','api_address'].filter(k=>node[k]!==undefined).map(k=>[k,node[k]]))})});
   result=await responseJson(response,`Регистрация ${node.id} / ${node.un_id}`);
  }catch(error){throw new Error(`${error.message}. Ранее созданные в этом запуске регистрации и файлы сохранены; исключите успешные УН из следующей регистрации. Токены автоматически не меняются.`);}
  const project=node.project_path||'C:/script_factory';
  const config={central_url:base,node_id:node.id,un_id:node.un_id,token:result.token,api_url:node.api_url||'http://127.0.0.1:33001',project_path:project,env_file:node.env_file||project+'/.env',worker_task_name:node.worker_task_name||'ScriptFactory-Test-UN',worker_task_path:node.worker_task_path||'\\',backup_root:node.backup_root||'C:/ScriptFactory-backups',data_dir:'C:/ProgramData/ScriptFactoryAgent/data',release_public_key:'C:/ProgramData/ScriptFactoryAgent/release-public.pem',poll_seconds:30};
  await writeFile(path.join(out,node.id+'.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Enrolled '+node.id+'; token saved to the protected enrollment file');
 }
}
// Windows PowerShell 5.1 + ErrorActionPreference=Stop can hide native stderr
// before the useful line. Print the concise reason to stdout before exiting.
main().catch(error=>{console.log('Ошибка регистрации: '+redact(error.message));process.exitCode=1;});
