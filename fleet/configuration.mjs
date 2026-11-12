import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {fault,identifier,textIdentity} from './common.mjs';
export const secretKeys=new Set(['API_KEY','WEB_PASSWORD','CALLBACK_AUTH_USERNAME','CALLBACK_AUTH_PASSWORD','NOVNC_PASSWORD','DEMO_MAIL_PASSWORD','YAHOO_MAIL_PASSWORD','BROWSER_OPTIONS_JSON']);
export const bootstrapKeys=new Set(['PORT','HOST','DATA_DIR','WORKER_PORT','WORKER_ACCOUNT','EXECUTION_MODE','WORKER_AUTH_TOKEN','WORKER_TASK_NAME']);
const keys=new Set(('PORT HOST DATA_DIR FILESYSTEM_ALLOWED_ROOTS MAX_PARALLEL_JOBS DEFAULT_JOB_TIMEOUT_MS JOB_RETENTION_DAYS RETRY_MAX_ATTEMPTS RETRY_BACKOFF_MS WEB_LOGIN WEB_SESSION_TTL_HOURS WEB_COOKIE_SECURE BROWSER_HEADLESS BROWSER_PRODUCT BROWSER_STEP_DELAY_MS BROWSER_HOLD_OPEN_MS BROWSER_CAPTCHA_WAIT_MS BROWSER_WINDOW_WIDTH BROWSER_WINDOW_HEIGHT BROWSER_OPTIONS_JSON BROWSER_EXECUTABLE_ALLOWLIST WORKFLOW_LIMITS_JSON PUPPETEER_EXECUTABLE_PATH CALLBACK_ALLOWED_ORIGINS POWER_MODE POWER_ENABLED POWER_BACKGROUND_ENABLED POWER_DRY_RUN POWER_EXCLUDED_USER POWER_USER_IDLE_SECONDS POWER_CHECK_INTERVAL_SECONDS POWER_GRACE_SECONDS POWER_RESUME_COOLDOWN_SECONDS IP_CHECK_URL IP_CHECK_FALLBACK_URL IP_MONITOR_SETTINGS_PATH WORKER_STARTUP_MS WORKER_HEARTBEAT_MS WORKER_LOST_MS WORKER_CANCEL_MS WORKER_MAX_MESSAGE_BYTES WORKER_MAX_PARALLEL_JOBS NOVNC_ENABLED NOVNC_INTERNAL_PORT NOVNC_PUBLIC_PORT NOVNC_PUBLIC_URL SERVICE_BASE_URL JOB_CLEANUP_INTERVAL_MS PERSIST_DEBOUNCE_MS').split(' '));
const clean=v=>typeof v==='string'&&v.length<=16384&&!/[\x00-\x1f\x7f]/.test(v);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
export function validateLayer(input){
 if(!plain(input)||Object.keys(input).some(k=>!['id','name','env','secret_refs','expected_revision','profile_id','bootstrap'].includes(k)))throw fault('INVALID_CONFIG_LAYER','Expected profile values and secret references');
 const env=input.env||{},refs=input.secret_refs||{};if(!plain(env)||!plain(refs)||Object.keys(env).length>100||Object.keys(refs).length>20)throw fault('INVALID_CONFIG_LAYER','Invalid environment map');
 for(const [k,v] of Object.entries(env)){
  if(!keys.has(k)||secretKeys.has(k))throw fault('INVALID_CONFIG_KEY','Unsupported key or secret must be supplied through a secret reference');
  if(v!==null&&!clean(v))throw fault('INVALID_CONFIG_VALUE',k+': expected a single-line string or null');
  if(v!==null){
   if(/^(POWER_ENABLED|POWER_BACKGROUND_ENABLED|POWER_DRY_RUN|WEB_COOKIE_SECURE|BROWSER_HEADLESS|NOVNC_ENABLED)$/.test(k)&&!['true','false'].includes(v))throw fault('INVALID_CONFIG_VALUE','Boolean must be true or false');
   if(/(_MS|_SECONDS|_DAYS|_HOURS|_WIDTH|_HEIGHT|PORT|MAX_PARALLEL_JOBS|RETRY_MAX_ATTEMPTS|WORKER_MAX_MESSAGE_BYTES)$/.test(k)&&(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))))throw fault('INVALID_CONFIG_VALUE','Numeric parameter requires an integer');
   if(k==='POWER_MODE'&&!['shutdown','sleep','hibernate'].includes(v))throw fault('INVALID_CONFIG_VALUE','Invalid Windows power mode');
   if(k.endsWith('_JSON')||k==='BROWSER_EXECUTABLE_ALLOWLIST'){try{JSON.parse(v);}catch{throw fault('INVALID_CONFIG_VALUE','Invalid JSON parameter');}}
  }
 }
 for(const [k,v] of Object.entries(refs))if(!secretKeys.has(k)||v!==null&&!identifier(v))throw fault('INVALID_SECRET_REFERENCE','Use an existing secret id for a supported secret field');
 if(input.name!==undefined&&!textIdentity(input.name))throw fault('INVALID_CONFIG_LAYER','Invalid profile name');
 return {env,secret_refs:refs};
}
export function vault(key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw fault('CONFIGURATION_LOCKED','Configure a 32-byte master key outside the database',503);
 return {
  fingerprint:createHash('sha256').update(key).digest('hex'),
  seal(value,aad){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return {iv:iv.toString('base64'),data:data.toString('base64'),tag:c.getAuthTag().toString('base64')};},
  open(value,aad){try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]).toString('utf8'));}catch{throw fault('VAULT_DECRYPT_FAILED','Master key or encrypted data is invalid',503);}}
 };
}
export function resolvedConfiguration(state,node,v){
 const assignment=node.configuration||{},profile=assignment.profile_id?state.profiles[assignment.profile_id]:null;
 if(assignment.profile_id&&!Object.hasOwn(state.profiles,assignment.profile_id))throw fault('PROFILE_NOT_FOUND','Assigned profile no longer exists',409);
 const env={...profile?.env,...assignment.env},refs={...profile?.secret_refs,...assignment.secret_refs};
 for(const [k,id] of Object.entries(refs)){
  if(id===null){env[k]=null;continue;}
  const secret=state.secrets[id];if(!secret)throw fault('SECRET_NOT_FOUND','A referenced secret no longer exists',409);
  env[k]=v.open(secret.encrypted,'secret:'+id).value;
  if(k==='BROWSER_OPTIONS_JSON'){try{JSON.parse(env[k]);}catch{throw fault('INVALID_CONFIG_VALUE','Browser options secret must contain valid JSON');}}
 }
 for(const k of ['API_KEY','WEB_PASSWORD'])if(Object.hasOwn(env,k)&&!env[k])throw fault('INVALID_CONFIGURATION','Required API and web credentials cannot be cleared');
 if(Boolean(env.CALLBACK_AUTH_USERNAME)!==Boolean(env.CALLBACK_AUTH_PASSWORD))throw fault('INCOMPLETE_CALLBACK_AUTH','Callback requires both Basic fields');
 return {env,profile_revision:profile?.revision||0,assignment_revision:assignment.revision||0,secret_revisions:Object.fromEntries(Object.entries(refs).filter(([,id])=>id!==null).map(([k,id])=>[k,state.secrets[id].revision]))};
}
export function maskedConfiguration(state,node,v){const r=resolvedConfiguration(state,node,v);return {...r,env:Object.fromEntries(Object.entries(r.env).map(([k,val])=>[k,secretKeys.has(k)?(val===null?null:'[secret]'):val])),bootstrap_required_keys:Object.keys(r.env).filter(k=>bootstrapKeys.has(k)&&r.env[k]!==node.config_facts?.[k])};}
export function validateBootstrap(input={}){
 if(!plain(input)||Object.keys(input).some(k=>!['host','worker_account','windows_username','windows_password_ref','project_path','env_file','saby_executable_path'].includes(k)))throw fault('INVALID_BOOTSTRAP','Unsupported bootstrap fields');
 for(const [k,value] of Object.entries(input))if(!clean(value)||value.length>512||k==='windows_password_ref'&&!identifier(value))throw fault('INVALID_BOOTSTRAP','Invalid bootstrap field');
 return input;
}
export function encodeEnv(values){return Object.entries(values).filter(([,v])=>v!==null).map(([k,v])=>{const quote=v.includes('"')?"'":'"';if(!/^[A-Z][A-Z0-9_]*$/.test(k)||!clean(v)||v.includes(quote))throw fault('ENV_ENCODING_FAILED','Value cannot be represented safely in the deployment environment');return k+'='+quote+v+quote;}).join('\n')+'\n';}

export function validateNodeMetadata(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['display_name','network_address','rdp_address','api_address','expected_revision'].includes(k)))throw fault('INVALID_NODE_METADATA','Unsupported node metadata');
 const result={};
 for(const k of ['display_name','network_address','rdp_address','api_address'])if(input[k]!==undefined){const value=input[k];if(typeof value!=='string'||value.length>512||/[\x00-\x1f\x7f]/.test(value))throw fault('INVALID_NODE_METADATA','Invalid node address');if(k!=='display_name'&&value&&(/[\s@]/.test(value)))throw fault('INVALID_NODE_METADATA','Addresses must not contain credentials or whitespace');if(k==='api_address'&&value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error();}catch{throw fault('INVALID_NODE_METADATA','API address must be an HTTP(S) origin');}}result[k]=value;}
 return result;
}
