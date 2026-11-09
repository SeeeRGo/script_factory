import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {executeJsonWorkflow} from '../src/json-workflow.js';

const template=JSON.parse(await readFile(new URL('../demo/sbis-report-full.json',import.meta.url),'utf8'));
const steps=[];
function walk(value){if(!value||typeof value!=='object')return;if(value.action)steps.push(value);for(const v of Object.values(value))if(typeof v==='object')walk(v);}
walk(template);
const wait=steps.find(s=>s.title==='Дождаться точного подтверждённого статуса отправки');
const read=steps.find(s=>s.save_as==='confirmed_sent_status');

for(const scenario of ['delayed','busy_caption','busy_role','never_finished','duplicate','changed_card','status_regression']){
 test(`SBIS confirmation: ${scenario}`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sbis-confirmation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  // The status is already visible underneath the sending overlay, as on the demo screenshot.
  const html=`<div id="card"><div id="status">${scenario==='delayed'?'Отправляется':'Отчёт   отправлен,\nно еще не считается сданным'}</div>${scenario==='duplicate'?'<div id="status">Отчет сдан</div>':''}</div>
   <aside id="busy" ${scenario==='busy_role'?'role="progressbar"':''}>${scenario==='busy_caption'||scenario==='never_finished'?'Отправка':''}</aside>
   <script>window.started=Date.now();window.finished=null;
   ${['busy_caption','busy_role','delayed','status_regression'].includes(scenario)?`setTimeout(()=>{document.querySelector('#busy').remove();document.querySelector('#status').textContent='Отчёт отправлен, но еще не считается сданным';window.finished=Date.now()},350);`:''}
   ${scenario==='status_regression'?`setTimeout(()=>document.querySelector('#status').textContent='Отправляется',100);`:''}
   </script>`;
  const script={format:'json-workflow',capture_error_screenshot:false,context:{ui:{...template.context.ui,sent_scope_selector:scenario==='changed_card'?'#missing':'#card',sent_status_selector:'#status'},report:{report_key:'fixture'},submit_status_stable_ms:150,submit_timeout_ms:1200,submit_step_timeout_ms:6200},
   steps:[{action:'browser_launch'},{action:'browser_steps',params:{steps:[{type:'navigate',url:'data:text/html;charset=utf-8,'+encodeURIComponent(html)}]}},structuredClone(wait),structuredClone(read),
    {action:'browser_eval',params:{expression:'({elapsed:Date.now()-window.started,afterFinish:window.finished===null?null:Date.now()-window.finished,busy:!!document.querySelector("#busy"),status:document.querySelector("#status").innerText})'},save_as:'proof'}],
   output:{status:'{{confirmed_sent_status}}',proof:'{{proof}}'}};
  const opts={script,headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,allowedRoots:[root],artifactDirectory:path.join(root,'artifacts')};
  if(['never_finished','duplicate','changed_card'].includes(scenario)){
   await assert.rejects(executeJsonWorkflow(opts),e=>e.code==='WORKFLOW_ERROR'&&/Waiting failed/.test(e.message));return;
  }
  const result=await executeJsonWorkflow(opts);
  assert.equal(result.context.status,'Отчёт отправлен, но еще не считается сданным');
  assert.equal(result.context.proof.busy,false);
  assert.ok(result.context.proof.afterFinish>=150,'Must wait for an uninterrupted quiet period after the overlay disappears');
 });
}
