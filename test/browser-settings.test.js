import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createServer} from 'node:http';
import {resolveBrowserSettings,prepareBrowserLaunch,redactBrowserParameters} from '../src/browser-settings.js';
import {resolveWorkflowLimits} from '../src/workflow-limits.js';
import {executeJsonWorkflow,computeWorkflowExpression} from '../src/json-workflow.js';
import {executeBrowserReplay} from '../src/browser-replay.js';
const click=selector=>({type:'click',selectors:[[selector]],offsetX:10,offsetY:10});
test('browser settings precedence, no silent clamping, malformed configuration and credential redaction',()=>{
 const env={BROWSER_STEP_DELAY_MS:'100',BROWSER_OPTIONS_JSON:'{"step_delay_ms":6000,"headless":false}'};
 const s=resolveBrowserSettings({env,script:{step_delay_ms:7000},context:{window_width:1900},launch:{step_delay_ms:8000}});
 assert.equal(s.step_delay_ms,8000);assert.equal(s.window_width,1900);assert.equal(s.headless,false);
 for(const config of [{step_delay_ms:-1},{headless:'false'},{protocol_timeout_ms:0},{unknown:1},{args:['--user-data-dir=C:/bad']},{args:['/USER-DATA-DIR=C:/bad']},{args:['--renderer-cmd-prefix=bad']},{download_behavior:'allow'},{executable_path:'/bin/sh'},{proxy_server:'http://user:password@host:1234'}])assert.throws(()=>resolveBrowserSettings({env:{},script:config}));
 assert.equal(resolveBrowserSettings({env:{BROWSER_EXECUTABLE_ALLOWLIST:'["/approved/browser"]'},script:{executable_path:'/approved/browser'}}).executable_path,'/approved/browser');
 assert.throws(()=>resolveBrowserSettings({env:{BROWSER_OPTIONS_JSON:'[]'}}));
 const redacted=JSON.stringify(redactBrowserParameters({proxy_password:'password',args:['http://user:password@host']}));assert.equal(redacted.includes('password'),true);assert.equal(redacted.includes(':password@'),false);assert.equal(JSON.parse(redacted).proxy_password,'***');
});
test('profile and extension paths respect allowed roots',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'browser-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ext=path.join(root,'ext');await mkdir(ext);
 const settings=resolveBrowserSettings({env:{},script:{user_data_dir:path.join(root,'profile'),extensions:[ext],launch_timeout_ms:90000,protocol_timeout_ms:240000,window_width:2000}});
 const p=await prepareBrowserLaunch(settings,[root]);assert.equal(p.options.timeout,90000);assert.equal(p.options.protocolTimeout,240000);assert.equal(p.options.enableExtensions,true);assert.equal(p.options.userDataDir,path.join(root,'profile'));
 const outside=await mkdtemp(path.join(tmpdir(),'browser-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,path.join(root,'escape'),'dir');
 await assert.rejects(prepareBrowserLaunch({...settings,user_data_dir:path.join(root,'escape')},[root]),{code:'FILESYSTEM_ACCESS_DENIED'});
});
test('workflow limits are configurable while malformed values are rejected',async()=>{
 assert.throws(()=>resolveWorkflowLimits({max_steps:0}));
 const script={format:'json-workflow',limits:{max_steps:1},steps:[{action:'set',params:{first:true}},{action:'set',params:{second:true}}]};
 await assert.rejects(executeJsonWorkflow({script}),{code:'WORKFLOW_LIMIT'});
 script.limits.max_steps=2;assert.equal((await executeJsonWorkflow({script})).context.second,true);
 const limits=resolveWorkflowLimits({max_expression_chars:2});await assert.rejects(computeWorkflowExpression('123',{},limits),{code:'INVALID_EXPRESSION'});
});
test('shared browser configuration persists profile, handles dialogs, downloads and HTTP credentials',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'browser-config-live-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const received=[];
 const extension=path.join(root,'extension');await mkdir(extension);await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Configuration fixture',version:'1.0',content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js']}]}));await writeFile(path.join(extension,'content.js'),"document.documentElement.setAttribute('data-fixture-extension','ready')");
 const server=createServer((req,res)=>{
  received.push(req.headers);
  if(req.url==='/download'){res.writeHead(200,{'Content-Disposition':'attachment; filename="sample.txt"','Content-Type':'text/plain'});res.end('download test');return;}
  if(req.url==='/auth'){
   if(req.headers.authorization!=='Basic '+Buffer.from('test:secret').toString('base64')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="test"'});res.end();return;}res.end('<title>Authorized</title>');return;
  }
  res.setHeader('Content-Type','text/html');res.end('<title>Settings</title><button id="prompt" onclick="window.answer=prompt(\'Question\')">Prompt</button><a id="download" href="/download">Download</a>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const browser={ignore_default_args:true,extensions:[extension],user_agent:'ScriptFactory-TestAgent',locale:'ru-RU',timezone_id:'Europe/Samara',extra_http_headers:{'X-Test':'configured'},permissions:[{origin,permissions:['geolocation']}],headless:true,user_data_dir:path.join(root,'profile'),window_width:1000,window_height:700,dialog_action:'accept',dialog_prompt_text:'answer',download_dir:path.join(root,'downloads'),download_behavior:'allow',proxy_username:'test',proxy_password:'secret',step_delay_ms:30};
 const script={format:'json-workflow',browser,steps:[{action:'browser_launch'},{action:'browser_steps',params:{steps:[{type:'navigate',url:origin},{type:'waitForExpression',expression:"document.documentElement.getAttribute('data-fixture-extension')==='ready'",timeout:5000},click('#prompt')]}},{action:'browser_eval',params:{expression:"(async()=>{localStorage.setItem('saved','yes');return {answer:window.answer,width:innerWidth,ua:navigator.userAgent,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,permission:(await navigator.permissions.query({name:'geolocation'})).state};})()"},save_as:'observed'},{action:'browser_steps',params:{steps:[click('#download')]}},{action:'wait',params:{duration_ms:500}}],output:{observed:'{{observed}}'}};
 const r=await executeJsonWorkflow({script,allowedRoots:[root]});assert.equal(r.context.observed.answer,'answer');assert.equal(r.context.observed.width,1000);assert.equal(r.context.observed.ua,'ScriptFactory-TestAgent');assert.equal(r.context.observed.zone,'Europe/Samara');assert.equal(r.context.observed.permission,'granted');assert.ok(received.some(h=>h['x-test']==='configured'&&h['accept-language']==='ru-RU'));
 let contents;for(let i=0;i<40;i++){try{contents=await readFile(path.join(root,'downloads','sample.txt'),'utf8');break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.equal(contents,'download test');
 const events=[];const n=await executeBrowserReplay({allowedRoots:[root],headless:true,artifactDirectory:path.join(root,'artifacts'),context:{},onEvent:e=>events.push(e),script:{format:'puppeteer-replay',title:'Native settings',browser,steps:[{type:'navigate',url:origin},{type:'waitForExpression',expression:"localStorage.getItem('saved')==='yes'"},{type:'navigate',url:origin+'/auth'}]}});
 assert.equal(n.context.page_title,'Authorized');assert.equal(events.filter(e=>e.type==='step_completed').length,3);
});

test('browser settings support explicit viewport null and command-line switches without fixed window bounds',async()=>{
 const s=resolveBrowserSettings({env:{},script:{viewport:null,window_width:4000,step_delay_ms:7000,hold_open_ms:120000,captcha_wait_ms:600000,user_agent:'test-agent',locale:'ru-RU',timezone_id:'Europe/Samara',extra_http_headers:{'X-Test':'value'},args:['--no-sandbox']}});
 const p=await prepareBrowserLaunch(s,[]);assert.equal(p.options.defaultViewport,null);assert.equal(s.step_delay_ms,7000);assert.equal(s.hold_open_ms,120000);assert.equal(s.captcha_wait_ms,600000);assert.ok(p.options.args.includes('--window-size=4000,860'));
});


test('an explicitly configured missing browser does not silently launch a different browser',async()=>{
 const {resolveBrowserExecutablePath}=await import('../src/browser-replay.js');
 await assert.rejects(resolveBrowserExecutablePath('/missing-script-factory-browser'),{code:'BROWSER_LAUNCH_ERROR'});
});

test('HTTP health reports effective browser defaults and malformed browser configuration',async t=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const root=await mkdtemp(path.join(tmpdir(),'browser-config-api-'));let child;
 const stop=async()=>{if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}};
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const start=async browser=>{
  child=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(import.meta.dirname,'..'),stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),API_KEY:'test',UN_ID:'settings-test',WEB_LOGIN:'test',WEB_PASSWORD:'test',DATA_DIR:root,FILESYSTEM_ALLOWED_ROOTS:root,BROWSER_HEADLESS:'true',BROWSER_OPTIONS_JSON:JSON.stringify(browser)}});
  for(let i=0;i<100;i++){try{const response=await fetch(`http://127.0.0.1:${port}/health`);return {status:response.status,body:await response.json()};}catch{await new Promise(r=>setTimeout(r,40));}}throw Error('Health unavailable');
 };
 let h=await start({headless:false,step_delay_ms:9500,launch_timeout_ms:90000});assert.equal(h.status,200);assert.equal(h.body.browser_replay.headless,false);assert.equal(h.body.browser_replay.step_delay_ms,9500);
 await stop();h=await start({launch_timeout_ms:-1});assert.equal(h.status,503);assert.equal(h.body.ready,false);assert.match(h.body.checks.browser.message,/launch_timeout_ms/);
});
