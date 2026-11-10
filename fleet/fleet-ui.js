let snapshot,selected=new Set(),pending=false;
const $=id=>document.getElementById(id);
const text=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value??'—');return e;};
const say=value=>{$('message').textContent=value;};
async function api(route,body,method='POST',type='application/json'){
 const r=await fetch(route,{method,headers:{'Content-Type':type},body:type==='application/json'?JSON.stringify(body):body});
 const data=await r.json();if(!r.ok)throw new Error(data.error?.code+': '+data.error?.message);return data;
}
function button(caption,run){const b=text('button',caption);b.type='button';b.className='secondary';b.onclick=()=>action(run);return b;}
async function action(run){if(pending)return;pending=true;try{await run();await refresh();}catch(e){say(e.message);}finally{pending=false;}}
function row(target,cells){const tr=document.createElement('tr');for(const v of cells){const td=document.createElement('td');if(v instanceof Node)td.append(v);else td.textContent=String(v??'—');tr.append(td);}$(target).append(tr);}
function drawNodes(){
 $('nodes').replaceChildren();
 for(const n of Object.values(snapshot.nodes).filter(n=>!$('group-filter').value||n.group.includes($('group-filter').value))){
  const box=document.createElement('input');box.type='checkbox';box.checked=selected.has(n.id);box.disabled=n.revoked;box.onchange=()=>box.checked?selected.add(n.id):selected.delete(n.id);
  const controls=document.createElement('div');
  controls.append(button('Отозвать',async()=>{await api('/api/nodes/'+n.id+'/revoke',{});selected.delete(n.id);say('Ключ агента отозван.');}),button('Новый ключ',async()=>{const r=await api('/api/nodes/'+n.id+'/rotate',{});say('Новый ключ '+n.id+' (сохраните сейчас):\n'+r.token);}));
  const online=n.last_seen&&Date.now()-Date.parse(n.last_seen)<180000;
  row('nodes',[box,n.id+' / '+n.un_id,n.group,n.version,(online?'На связи':'Нет связи')+' / '+(n.maintenance?'Обслуживание':n.api_ready?'API готов':'API не готов'),n.last_seen,controls]);
 }
}
async function refresh(){
 const r=await fetch('/api/fleet');if(!r.ok)throw new Error('Не удалось получить состояние');snapshot=await r.json();drawNodes();
 const select=$('release-select'),old=select.value;select.replaceChildren();
 for(const release of Object.values(snapshot.releases).filter(r=>r.ready)){const o=text('option',release.manifest.version+' / '+release.manifest.id);o.value=release.manifest.id;select.append(o);}if([...select.options].some(o=>o.value===old))select.value=old;
 $('releases').textContent=Object.values(snapshot.releases).map(r=>r.manifest.version+': '+(r.ready?'готов':'ожидает ZIP')).join('; ');
 for(const id of ['rollouts','deployments','events'])$(id).replaceChildren();
 for(const r of Object.values(snapshot.rollouts).reverse()){
  const buttons=document.createElement('div');for(const [caption,op] of [['Пауза','pause'],['Продолжить','resume'],['Отменить ожидающие','cancel']])buttons.append(button(caption,()=>api('/api/rollouts/'+r.id+'/'+op,{})));
  row('rollouts',[r.id+' / '+r.release_id,r.status+(r.pause_reason?' / '+r.pause_reason:''),r.start_at+' — '+r.end_at,buttons]);
 }
 for(const d of Object.values(snapshot.deployments).reverse())row('deployments',[d.node_id,d.id,d.status,d.error_code,['failed','rolled_back'].includes(d.status)?button('Повторить',()=>api('/api/deployments/'+d.id+'/retry',{})):d.status==='recovery_required'?button('Подтвердить восстановление',()=>api('/api/deployments/'+d.id+'/resolve',{confirm_recovered:true})):'' ]);
 for(const e of snapshot.events.slice(-100).reverse())row('events',[e.at,e.type,e.node_id||e.deployment_id||e.rollout_id,e.reason||e.error_code]);
}
$('group-filter').oninput=()=>snapshot&&drawNodes();
$('node-form').onsubmit=e=>{e.preventDefault();action(async()=>{const r=await api('/api/nodes',Object.fromEntries(new FormData(e.target)));say('УН зарегистрирована. Ключ '+r.node.id+' (сохраните сейчас):\n'+r.token);});};
$('release-form').onsubmit=e=>{e.preventDefault();action(async()=>{const form=new FormData(e.target),envelope=JSON.parse(await form.get('manifest').text());if(!snapshot.releases[envelope.manifest.id])await api('/api/releases',envelope);await api('/api/releases/'+envelope.manifest.id+'/package',form.get('zip'),'PUT','application/zip');say('Релиз загружен и проверен.');});};
$('rollout-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target));const ids=[...$('nodes').querySelectorAll('input:checked')].map(b=>b.closest('tr').children[1].textContent.split(' / ')[0]);const r=await api('/api/rollouts',{release_id:f.release_id,node_ids:ids,batch_size:Number(f.batch_size),canary_count:Number(f.canary_count),start_at:new Date(f.start_at).toISOString(),end_at:new Date(f.end_at).toISOString()});say('Раскатка создана: '+r.id);});};
const localDate=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
$('rollout-form').elements.start_at.value=localDate(new Date());$('rollout-form').elements.end_at.value=localDate(new Date(Date.now()+86400000));
refresh().then(()=>say('Состояние обновляется каждые 10 секунд.')).catch(e=>say(e.message));
setInterval(()=>{if(!pending)refresh().catch(e=>say(e.message));},10000);
