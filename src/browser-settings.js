import { InterpreterError } from './interpreter.js';
import path from 'node:path';
import { checkedWorkflowPath, createWorkflowDirectory } from './workflow-files.js';

const defaults = {
  headless:true, launch_timeout_ms:30000, protocol_timeout_ms:180000,
  default_timeout_ms:30000, navigation_timeout_ms:30000,
  window_width:1400, window_height:860, viewport:'auto',
  user_data_dir:null, profile_directory:null, executable_path:null,
  args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  ignore_default_args:false, enable_extensions:false, extensions:[],
  proxy_server:null, proxy_bypass_list:null, proxy_username:null, proxy_password:null,
  user_agent:null, locale:null, timezone_id:null, extra_http_headers:{},
  accept_insecure_certs:false, slow_mo_ms:0, step_delay_ms:0, hold_open_ms:0,
  captcha_wait_ms:0, captcha_poll_ms:500,
  download_dir:null, download_behavior:'default',
  dialog_action:'dismiss', dialog_prompt_text:'', permissions:[],
};
const timers=['launch_timeout_ms','protocol_timeout_ms','default_timeout_ms','navigation_timeout_ms','captcha_poll_ms'];
const delays=['slow_mo_ms','step_delay_ms','hold_open_ms','captcha_wait_ms'];
function normalizeBrowserSettings({env=process.env,legacy={},script={},context={},launch={}}={}) {
  let configured={};
  try { configured=env.BROWSER_OPTIONS_JSON?JSON.parse(env.BROWSER_OPTIONS_JSON):{}; }
  catch { throw new Error('BROWSER_OPTIONS_JSON: некорректный JSON'); }
  const old={};
  const mapping={PUPPETEER_EXECUTABLE_PATH:'executable_path',BROWSER_WINDOW_WIDTH:'window_width',BROWSER_WINDOW_HEIGHT:'window_height',BROWSER_STEP_DELAY_MS:'step_delay_ms',BROWSER_HOLD_OPEN_MS:'hold_open_ms',BROWSER_CAPTCHA_WAIT_MS:'captcha_wait_ms'};
  for(const [key,name] of Object.entries(mapping))if(env[key]!==undefined)old[name]=name==='executable_path'?env[key]:Number(env[key]);
  if(env.BROWSER_HEADLESS!==undefined)old.headless=env.BROWSER_HEADLESS!=='false';
  const layers=[old,legacy,configured,script,context,launch];
  const result=structuredClone(defaults);
  for(const layer of layers){
    if(!layer||typeof layer!=='object'||Array.isArray(layer))throw new Error('browser: требуется объект настроек');
    for(const [key,value] of Object.entries(layer)){
      if(!Object.hasOwn(defaults,key))throw new Error(`Неизвестная настройка browser.${key}`);
      if(value!==undefined)result[key]=value;
    }
  }
  for(const key of [...timers,...delays,'window_width','window_height']){
    const v=result[key],min=delays.includes(key)?0:1;
    if(!Number.isInteger(v)||v<min||v>2147483647)throw new Error(`browser.${key}: требуется целое число ${min}..2147483647`);
  }
  for(const key of ['headless','enable_extensions','accept_insecure_certs'])if(typeof result[key]!=='boolean')throw new Error(`browser.${key}: требуется boolean`);
  if(typeof result.ignore_default_args!=='boolean'&&!(Array.isArray(result.ignore_default_args)&&result.ignore_default_args.every(x=>typeof x==='string')))throw new Error('browser.ignore_default_args: требуется boolean или массив строк');
  for(const key of ['args','extensions'])if(!Array.isArray(result[key])||result[key].some(v=>typeof v!=='string'||!v))throw new Error(`browser.${key}: требуется массив строк`);
  for(const key of ['user_data_dir','profile_directory','executable_path','proxy_server','proxy_bypass_list','proxy_username','proxy_password','download_dir','user_agent','locale','timezone_id'])if(result[key]!==null&&(typeof result[key]!=='string'||!result[key]))throw new Error(`browser.${key}: требуется непустая строка или null`);
  if(typeof result.dialog_prompt_text!=='string')throw new Error('browser.dialog_prompt_text: требуется строка');
  if(!['accept','dismiss','ignore'].includes(result.dialog_action))throw new Error('browser.dialog_action: accept, dismiss или ignore');
  if(!['default','allow','deny','allowAndName'].includes(result.download_behavior))throw new Error('browser.download_behavior: default, allow, deny или allowAndName');
  if(['allow','allowAndName'].includes(result.download_behavior)&&!result.download_dir)throw new Error('browser.download_dir обязателен для разрешённого скачивания');
  if(result.profile_directory&&(path.basename(result.profile_directory)!==result.profile_directory||['.','..'].includes(result.profile_directory)))throw new Error('browser.profile_directory: требуется имя профиля, не путь');
  if(result.proxy_server&&/^[a-z]+:\/\/[^/]*@/i.test(result.proxy_server))throw new Error('Укажите учётные данные прокси отдельно от proxy_server');
  if(result.viewport!=='auto'&&result.viewport!==null&&(!result.viewport||typeof result.viewport!=='object'||!Number.isInteger(result.viewport.width)||!Number.isInteger(result.viewport.height)||result.viewport.width<1||result.viewport.height<1))throw new Error('browser.viewport: null или объект width/height');
  if(result.download_dir&&result.download_behavior==='default')result.download_behavior='allow';
  if(!result.extra_http_headers||typeof result.extra_http_headers!=='object'||Array.isArray(result.extra_http_headers)||Object.values(result.extra_http_headers).some(v=>typeof v!=='string'))throw new Error('browser.extra_http_headers: требуется объект строк');
  if(!Array.isArray(result.permissions))throw new Error('browser.permissions: требуется массив {origin,permissions}');
  for(const p of result.permissions){if(!p||!Array.isArray(p.permissions)||p.permissions.some(x=>typeof x!=='string'))throw new Error('Некорректные browser.permissions');const u=new URL(p.origin);if(!['http:','https:'].includes(u.protocol)||u.origin!==p.origin)throw new Error('browser.permissions.origin: требуется HTTP(S) origin без пути');}
  // Executables are approved by the UN configuration; a job cannot turn the
  // browser launcher into an arbitrary terminal-command operation.
  let approved=[];
  try { approved=env.BROWSER_EXECUTABLE_ALLOWLIST?JSON.parse(env.BROWSER_EXECUTABLE_ALLOWLIST):[]; } catch { throw new Error('BROWSER_EXECUTABLE_ALLOWLIST: некорректный JSON'); }
  if(!Array.isArray(approved)||approved.some(v=>typeof v!=='string'||!v))throw new Error('BROWSER_EXECUTABLE_ALLOWLIST: требуется массив путей');
  const normalizePath=value=>{const p=path.resolve(value);return process.platform==='win32'?p.toLowerCase():p;};
  approved.push(env.PUPPETEER_EXECUTABLE_PATH,legacy.executable_path,configured.executable_path);
  if(result.executable_path&&!approved.filter(Boolean).some(value=>normalizePath(value)===normalizePath(result.executable_path)))throw new Error('browser.executable_path не разрешён в конфигурации УН; добавьте путь в BROWSER_EXECUTABLE_ALLOWLIST');
  // Paths and profile flags go through explicit checked options, never raw args.
  for(const arg of result.args)if(/^(?:--?|\/)(?:user-data-dir|profile-directory|load-extension|disable-extensions-except|download-default-directory|remote-debugging-(?:port|address|pipe)|browser-subprocess-path|renderer-cmd-prefix|utility-cmd-prefix|gpu-launcher)(?:=|$)/i.test(arg))throw new Error('Используйте именованные настройки профиля/расширений вместо: '+arg.split('=')[0]);
  return result;
}
export function resolveBrowserSettings(options={}) {
  try { return normalizeBrowserSettings(options); }
  catch(error) { throw new InterpreterError('INVALID_BROWSER_OPTIONS',error.message,{statusCode:400,retryable:false}); }
}
export async function prepareBrowserLaunch(settings,allowedRoots,signal){
  const s={...settings};
  for(const key of ['user_data_dir','download_dir'])if(s[key]){
    try{s[key]=await checkedWorkflowPath(s[key],allowedRoots,true);}
    catch(e){if(e.code!=='FILE_NOT_FOUND')throw e;s[key]=await createWorkflowDirectory(s[key],allowedRoots,signal);}
  }
  const extensions=[];for(const value of s.extensions)extensions.push(await checkedWorkflowPath(value,allowedRoots,true));
  const args=[...s.args,`--window-size=${s.window_width},${s.window_height}`];
  if(s.locale)args.push(`--lang=${s.locale}`);
  // Puppeteer skips its userDataDir argument when ignoreDefaultArgs=true.
  if(s.user_data_dir&&s.ignore_default_args===true)args.push(`--user-data-dir=${s.user_data_dir}`);
  if(s.profile_directory)args.push(`--profile-directory=${s.profile_directory}`);
  if(s.proxy_server)args.push(`--proxy-server=${s.proxy_server}`);
  if(s.proxy_bypass_list)args.push(`--proxy-bypass-list=${s.proxy_bypass_list}`);
  if(s.ignore_default_args===true)args.push('--enable-automation','--no-first-run','--no-default-browser-check',...(s.headless?['--headless=new']:[]));
  if(extensions.length)args.push(`--load-extension=${extensions.join(',')}`,`--disable-extensions-except=${extensions.join(',')}`);
  return {settings:s,options:{headless:s.headless,timeout:s.launch_timeout_ms,protocolTimeout:s.protocol_timeout_ms,slowMo:s.slow_mo_ms,
    acceptInsecureCerts:s.accept_insecure_certs,ignoreDefaultArgs:s.ignore_default_args,
    enableExtensions:s.enable_extensions||extensions.length>0,args,
    ...(s.user_data_dir?{userDataDir:s.user_data_dir}:{}),
    defaultViewport:s.viewport==='auto'?(s.headless?{width:s.window_width,height:s.window_height}:null):s.viewport}};
}
const pageConfiguration=new WeakMap();
export async function configureBrowser(browser,settings){
  browser.on('targetcreated',target=>{if(target.type()==='page')void target.page().then(page=>page&&configureBrowserPage(page,settings)).catch(()=>{});});
  const context=browser.defaultBrowserContext();
  for(const p of settings.permissions)await context.overridePermissions(p.origin,p.permissions);
  if(settings.download_behavior!=='default'){
    const cdp=await browser.target().createCDPSession();
    // Download behavior belongs to this CDP client. Keep it attached until the browser closes.
    await cdp.send('Browser.setDownloadBehavior',{behavior:settings.download_behavior,...(settings.download_dir?{downloadPath:settings.download_dir}:{}),eventsEnabled:true});
  }
}
export function configureBrowserPage(page,settings,onError=()=>{}){
  if(pageConfiguration.has(page))return pageConfiguration.get(page);
  const configured=(async()=>{
    page.setDefaultTimeout(settings.default_timeout_ms);page.setDefaultNavigationTimeout(settings.navigation_timeout_ms);
    if(settings.user_agent)await page.setUserAgent(settings.user_agent);
    if(settings.locale||Object.keys(settings.extra_http_headers).length)await page.setExtraHTTPHeaders({...settings.locale?{'Accept-Language':settings.locale}:{},...settings.extra_http_headers});
    if(settings.timezone_id)await page.emulateTimezone(settings.timezone_id);
    if(settings.proxy_username!==null||settings.proxy_password!==null)await page.authenticate({username:settings.proxy_username||'',password:settings.proxy_password||''});
    if(settings.dialog_action==='ignore')page.on('dialog',()=>{});
    else page.on('dialog',dialog=>{
      void (settings.dialog_action==='accept'?dialog.accept(settings.dialog_prompt_text):dialog.dismiss()).catch(onError);
    });
  })();
  pageConfiguration.set(page,configured);return configured;
}
export function redactBrowserParameters(value){
  if(Array.isArray(value))return value.map(redactBrowserParameters);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/password|token|secret|authorization|cookie|api[_-]?key/i.test(k)?'***':redactBrowserParameters(v)]));
  return typeof value==='string'?value.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g,'$1***@'):value;
}
