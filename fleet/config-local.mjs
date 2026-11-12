import {readFile,writeFile,unlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {parseEnv} from 'node:util';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {atomicJson,privateDirectory,fault} from './common.mjs';
import {validateLayer,secretKeys,bootstrapKeys,encodeEnv} from './configuration.mjs';
const queueKeys={MAX_PARALLEL_JOBS:['max_parallel_jobs',1],DEFAULT_JOB_TIMEOUT_MS:['default_job_timeout_ms',30000],JOB_RETENTION_DAYS:['job_retention_days',30],RETRY_MAX_ATTEMPTS:['max_attempts',2],RETRY_BACKOFF_MS:['backoff_ms',500]};
const powerKeys={POWER_MODE:'mode',POWER_ENABLED:'enabled',POWER_BACKGROUND_ENABLED:'background_enabled',POWER_DRY_RUN:'dry_run',POWER_EXCLUDED_USER:'excluded_user',POWER_USER_IDLE_SECONDS:'user_idle_seconds',POWER_CHECK_INTERVAL_SECONDS:'check_interval_seconds',POWER_GRACE_SECONDS:'grace_seconds',POWER_RESUME_COOLDOWN_SECONDS:'resume_cooldown_seconds'};
export function validateChanges(changes){
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw fault('INVALID_CONFIGURATION','Expected environment patch');
 validateLayer({env:Object.fromEntries(Object.entries(changes).filter(([k])=>!secretKeys.has(k)))});
 for(const [k,v] of Object.entries(changes)){
  if(['API_KEY','WEB_PASSWORD'].includes(k)&&!v)throw fault('INVALID_CONFIGURATION','Required API and web credentials cannot be cleared');
  if(bootstrapKeys.has(k))throw fault('BOOTSTRAP_REQUIRED','Reserved key cannot be changed on a working node');
  if(v!==null&&(typeof v!=='string'||v.length>16384||/[\x00-\x1f\x7f]/.test(v)))throw fault('INVALID_CONFIGURATION','Invalid environment value');
 }
}
async function inspect({projectPath,envFile,owner,unId}){
 const original=await readFile(envFile,'utf8'),env=parseEnv(original),dataDir=path.resolve(projectPath,env.DATA_DIR||'data');
 const m=JSON.parse(await readFile(path.join(dataDir,'maintenance','state.json'),'utf8'));
 if(env.UN_ID!==unId||!m.active||m.owner!==owner||m.phase!=='installing')throw fault('MAINTENANCE_OWNER_MISMATCH','Sealed maintenance required');
 return {original,env,dataDir};
}
function database(dataDir){const db=new DatabaseSync(path.join(dataDir,'state.sqlite'));db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');return db;}
export async function restoreConfiguration({projectPath,envFile,backupDir,owner,unId}){
 const file=path.join(backupDir,'snapshot.json'),s=JSON.parse(await readFile(file,'utf8'));
 if(s.project_path!==path.resolve(projectPath)||s.env_file!==path.resolve(envFile)||s.owner!==owner||s.un_id!==unId)throw fault('BACKUP_IDENTITY_MISMATCH','Configuration backup identity mismatch');
 const m=JSON.parse(await readFile(path.join(s.data_dir,'maintenance','state.json'),'utf8'));
 if(!m.active||m.owner!==owner||m.phase!=='installing')throw fault('MAINTENANCE_OWNER_MISMATCH','Sealed maintenance required');
 const db=database(s.data_dir);
 try{db.prepare('UPDATE app_config SET config_json=?,updated_at=? WHERE id=1').run(s.queue,new Date().toISOString());}finally{db.close();}
 const powerFile=path.join(s.data_dir,'power','config.json');
 if(s.power===null)await unlink(powerFile).catch(e=>{if(e.code!=='ENOENT')throw e;});else await writeFile(powerFile,s.power,{flush:true});
 await writeFile(envFile,s.original,{flush:true});
}
export async function applyConfiguration({projectPath,envFile,backupDir,owner,payload}){
 projectPath=path.resolve(projectPath);envFile=path.resolve(envFile);validateChanges(payload.env);
 const {original,env,dataDir}=await inspect({projectPath,envFile,owner,unId:payload.un_id});
 const next={...env};for(const [k,v] of Object.entries(payload.env)){if(v===null)delete next[k];else next[k]=v;}
 const encoded=encodeEnv(next); // Fully validate encoding before modifying anything.
 const db=database(dataDir);let originalQueue,queue,power=null,powerNext,writePower=false;
 try{
  originalQueue=db.prepare('SELECT config_json FROM app_config WHERE id=1').get()?.config_json;
  if(!originalQueue)throw fault('CONFIGURATION_DB_MISSING','API must initialize its configuration first');
  queue=JSON.parse(originalQueue);queue.retry_policy={...queue.retry_policy};
  for(const [key,[field,fallback]] of Object.entries(queueKeys))if(Object.hasOwn(payload.env,key)){
   const value=Number(next[key]??fallback);if(!Number.isSafeInteger(value)||value<(key==='RETRY_BACKOFF_MS'?0:1))throw fault('INVALID_CONFIGURATION','Invalid queue setting');
   if(key.startsWith('RETRY_'))queue.retry_policy[field]=value;else queue[field]=value;
  }
  const powerFile=path.join(dataDir,'power','config.json');
  try{power=await readFile(powerFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  powerNext=power?JSON.parse(power):{};
  for(const [key,field] of Object.entries(powerKeys))if(Object.hasOwn(payload.env,key)){
   writePower=true;
   if(payload.env[key]===null||field==='excluded_user'&&!next[key]){delete powerNext[field];continue;}
   const val=next[key];powerNext[field]=['enabled','background_enabled','dry_run'].includes(field)?val==='true':field.endsWith('_seconds')?Number(val):val;
  }
  const {validatePowerConfig,powerDefaults}=await import(pathToFileURL(path.join(projectPath,'src','power-management.js')).href);
  validatePowerConfig(powerNext,powerDefaults(next));
  await privateDirectory(backupDir);
  await atomicJson(path.join(backupDir,'snapshot.json'),{project_path:projectPath,env_file:envFile,data_dir:dataDir,owner,un_id:payload.un_id,config_version:payload.config_version,original,queue:originalQueue,power});
  db.prepare('UPDATE app_config SET config_json=?,updated_at=? WHERE id=1').run(JSON.stringify(queue),new Date().toISOString());
  if(writePower){const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dataDir,'power'),{recursive:true});await atomicJson(powerFile,powerNext);}
  await writeFile(envFile,encoded,{flush:true});
 }catch(e){db.close();try{await restoreConfiguration({projectPath,envFile,backupDir,owner,unId:payload.un_id});}catch{}throw fault(e.code||'CONFIGURATION_WRITE_FAILED','Configuration write failed; inspect the protected local backup');}
 db.close();return {updated:true,backup:backupDir};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,requestFile]=process.argv.slice(2);
 try{const options=JSON.parse(await readFile(requestFile,'utf8'));if(mode==='apply')await applyConfiguration({...options,payload:JSON.parse(await readFile(options.payloadFile,'utf8'))});else if(mode==='rollback')await restoreConfiguration(options);else throw fault('INVALID_MODE','Invalid local operation');}
 catch(e){console.error(/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'CONFIGURATION_OPERATION_FAILED');process.exitCode=1;}
}
