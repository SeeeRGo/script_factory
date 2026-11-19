import {activeStatuses,unfinishedStatuses,statusLabels,explainCode,operationBlocker,historyPage} from './operations.mjs';
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
 for(const n of Object.values(snapshot.nodes).filter(n=>(!$('group-filter').value||n.group.includes($('group-filter').value))&&(!$('node-search').value||[n.id,n.un_id,n.display_name,n.network_address,n.rdp_address,n.api_address,n.observed_host,...(n.observed_addresses||[])].join(' ').toLowerCase().includes($('node-search').value.toLowerCase())))){
  const box=document.createElement('input');box.type='checkbox';box.checked=selected.has(n.id);box.disabled=n.revoked;box.onchange=()=>box.checked?selected.add(n.id):selected.delete(n.id);
  const controls=document.createElement('div');
  controls.append(button('Адреса',async()=>{$('metadata-node').value=n.id;$('metadata-node').onchange();$('node-metadata-form').scrollIntoView({behavior:'smooth'});}));
  controls.append(button('Отозвать',async()=>{await api('/api/nodes/'+n.id+'/revoke',{});selected.delete(n.id);say('Ключ агента отозван.');}),button('Новый ключ',async()=>{const r=await api('/api/nodes/'+n.id+'/rotate',{});say('Новый ключ '+n.id+' (сохраните сейчас):\n'+r.token);}));
  controls.append(button('Удалить',async()=>{if(!confirm('Удалить регистрацию '+n.id+' / '+n.un_id+'? Ключ перестанет работать. История сохранится; агент Windows этим действием не удаляется.'))return;await api('/api/nodes/'+n.id,{confirm_delete:true},'DELETE');selected.delete(n.id);say('Регистрация '+n.id+' удалена. История операций сохранена.');}));
  box.dataset.nodeId=n.id;
  const online=n.last_seen&&Date.now()-Date.parse(n.last_seen)<180000;
  row('nodes',[box,n.id+' / '+n.un_id+' / '+(n.display_name||'')+'\nСеть: '+(n.network_address||n.configuration?.bootstrap?.host||'не задана')+'; RDP: '+(n.rdp_address||'не задан')+'; API: '+(n.api_address||'не задан')+'\nАгент: '+(n.observed_host||'—')+' '+(n.observed_addresses||[]).join(', '),n.group,'API: '+(n.version||'—')+'\nАгент: '+(n.agent_source_version||'неизвестна')+(n.agent_update_status==='failed'?' / ошибка обновления агента':n.agent_update_status==='pending'?' / ожидается обновление':'')+(n.config_capable?' / конфигурации':' / обновите агент'),(online?'На связи':'Нет связи')+' / '+(n.maintenance?'Обслуживание':n.api_ready?'API готов':'API не готов'),n.last_seen,controls]);
 }
}
let historyPages={rollouts:1,deployments:1,events:1},lastDiagnostics=null;
function filters(){return {query:$('history-query').value,status:$('history-status').value,from:$('history-from').value,to:$('history-to').value,limit:$('history-limit').value};}
function pageRows(id,items,extra={}){
 const result=historyPage(items,{...filters(),...extra,page:historyPages[id]});historyPages[id]=result.page;$(id).replaceChildren();
 $(id+'-count').textContent='Найдено: '+result.total+'; страница '+result.page+' из '+result.pages;
 $(id+'-prev').disabled=result.page<=1;$(id+'-next').disabled=result.page>=result.pages;return result.items;
}
function retryReason(d){const r=snapshot.rollouts[d.rollout_id];if(d.node_deleted_at||!snapshot.nodes[d.node_id])return 'Регистрация УН удалена; создайте новую раскатку.';if(!r||['completed','cancelled'].includes(r.status))return 'Раскатка закрыта; создайте новую.';if(Date.now()>Date.parse(r.end_at))return 'Сначала измените истёкшее окно раскатки.';return '';}
function openWindow(r){const form=$('window-form');form.elements.rollout_id.value=r.id;form.elements.start_at.value=localDate(new Date(Math.max(Date.now(),Date.parse(r.start_at))));form.elements.end_at.value=localDate(new Date(Math.max(Date.now()+3600000,Date.parse(r.end_at))));form.hidden=false;form.scrollIntoView({behavior:'smooth'});}
async function diagnostics(d){
 const response=await fetch('/api/deployments/'+d.id+'/diagnostics');const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Диагностика недоступна');lastDiagnostics=data;
 $('diagnostic-output').textContent=['УН: '+data.node_id+' / '+(data.address||'адрес не задан'),'Операция: '+data.operation_id,'Состояние: '+(statusLabels[data.status]||data.status)+' / '+data.status,'Причина: '+data.explanation,'Ожидание / следующий шаг: '+data.waiting_reason,'','Локальные файлы на УН:',...data.local_logs,'',data.logs_location,'',data.note,'','События центра:',...data.events.map(e=>e.at+' '+e.type+' '+(e.error_code||e.reason||''))].join('\n');
 $('operation-dialog').showModal();
}
function drawHistory(){
 const rollouts=Object.values(snapshot.rollouts).reverse().map(r=>({...r,search_nodes:r.node_ids.map(id=>{const n=snapshot.nodes[id];return [id,n?.un_id,n?.network_address,n?.display_name].join(' ');})}));
 for(const r of pageRows('rollouts',rollouts)){
  const buttons=document.createElement('div');
  if(!['completed','cancelled'].includes(r.status)){
   if(r.status==='running')buttons.append(button('Пауза',async()=>{await api('/api/rollouts/'+r.id+'/pause',{});say('Раскатка приостановлена. Активные установки завершаются.');}));
   buttons.append(button('Продолжить',async()=>{await api('/api/rollouts/'+r.id+'/resume',{});say('Раскатка продолжена. Проверьте время окна и связь агентов в результатах.');}),button('Изменить окно',()=>openWindow(r)),button('Отменить ожидающие',async()=>{await api('/api/rollouts/'+r.id+'/cancel',{});say('Ожидающие операции отменены; активные не прерываются.');}));
  }
  buttons.append(button('Операции',()=>{$('history-query').value=r.id;historyPages={rollouts:1,deployments:1,events:1};drawHistory();$('deployments').scrollIntoView({behavior:'smooth'});}));
  const reason=r.pause_reason?explainCode(r.pause_reason):Date.now()<Date.parse(r.start_at)?'Ожидает начала окна':'';
  row('rollouts',[r.id+' / '+(r.kind==='configuration'?'Конфигурация':r.release_id),(statusLabels[r.status]||r.status)+' / '+r.status+(reason?'\n'+reason:''),new Date(r.start_at).toLocaleString()+' — '+new Date(r.end_at).toLocaleString(),buttons]);
 }
 const deployments=Object.values(snapshot.deployments).reverse();
 for(const d of pageRows('deployments',deployments)){
  const controls=document.createElement('div');controls.append(button('Диагностика / журналы',()=>diagnostics(d)));
  if(['failed','rolled_back'].includes(d.status)){
   const reason=retryReason(d),b=button('Повторить',async()=>{const r=await api('/api/deployments/'+d.id+'/retry',{});say('Создана повторная попытка '+r.id+'. Если раскатка на паузе, нажмите «Продолжить» после устранения ошибок остальных УН.');});b.disabled=!!reason;b.title=reason;controls.append(b);
  }else if(d.status==='recovery_required')controls.append(button('Подтвердить восстановление',async()=>{if(!confirm('Подтвердите, что на '+d.node_id+' проверен результат установки и УН восстановлена. Эта кнопка сама её не восстанавливает.'))return;await api('/api/deployments/'+d.id+'/resolve',{confirm_recovered:true});say('Восстановление подтверждено. Для обновления нажмите «Повторить», затем продолжите раскатку.');}));
  const description=operationBlocker(d,snapshot),blocked=['failed','rolled_back'].includes(d.status)?retryReason(d):'';
  row('deployments',[d.node_id+' / '+(d.target_un_id||snapshot.nodes[d.node_id]?.un_id||'—')+' / '+(d.target_label||snapshot.nodes[d.node_id]?.display_name||'')+'\nСеть: '+(d.target_address||snapshot.nodes[d.node_id]?.network_address||'адрес не задан')+'\nRDP: '+(d.target_rdp||snapshot.nodes[d.node_id]?.rdp_address||'—')+'\nAPI: '+(d.target_api||snapshot.nodes[d.node_id]?.api_address||'—')+(d.node_deleted_at?'\nРегистрация удалена':''),d.id+'\n'+(d.created_at?new Date(d.created_at).toLocaleString():''),(statusLabels[d.status]||d.status)+' / '+d.status,(d.error_code?d.error_code+'\n':'')+description+(blocked?'\n'+blocked:''),controls]);
 }
 const oldType=$('event-type').value;options('event-type',[...new Set(snapshot.events.map(e=>e.type))].sort().map(t=>[t,t]),'Все события');if([...$('event-type').options].some(o=>o.value===oldType))$('event-type').value=oldType;
 for(const e of pageRows('events',snapshot.events.slice().reverse().filter(e=>!$('event-type').value||e.type===$('event-type').value),{status:''}))row('events',[new Date(e.at).toLocaleString(),e.type,e.node_id||e.deployment_id||e.rollout_id||e.profile_id||e.secret_id||e.node_ids?.join(', '),e.reason||e.error_code||(e.revision?'Редакция '+e.revision:'')]);
}
async function refresh(){
 const r=await fetch('/api/fleet');if(!r.ok)throw new Error('Не удалось получить состояние');snapshot=await r.json();drawNodes();drawConfiguration();
 const select=$('release-select'),old=select.value;select.replaceChildren();
 for(const release of Object.values(snapshot.releases).filter(r=>r.ready)){const o=text('option',release.manifest.version+' / '+release.manifest.id);o.value=release.manifest.id;select.append(o);}if([...select.options].some(o=>o.value===old))select.value=old;
 $('releases').textContent=Object.values(snapshot.releases).map(r=>r.manifest.version+': '+(r.ready?'готов':'ожидает ZIP')).join('; ');
 drawHistory();
}

$('group-filter').oninput=()=>snapshot&&drawNodes();
$('node-search').oninput=()=>snapshot&&drawNodes();
$('nodes-select-all').onclick=()=>{for(const box of $('nodes').querySelectorAll('input:not(:disabled)'))selected.add(box.dataset.nodeId);drawNodes();};
$('nodes-clear').onclick=()=>{selected.clear();drawNodes();};
$('node-form').onsubmit=e=>{e.preventDefault();action(async()=>{const r=await api('/api/nodes',Object.fromEntries(new FormData(e.target)));say('УН зарегистрирована. Ключ '+r.node.id+' (сохраните сейчас):\n'+r.token);});};
$('release-form').onsubmit=e=>{e.preventDefault();action(async()=>{const form=new FormData(e.target),envelope=JSON.parse(await form.get('manifest').text());if(!envelope?.manifest||typeof envelope.signature!=='string')throw new Error('Выберите подписанный manifest релиза, созданный fleet:release build, и соответствующий ZIP. nodes.json — список УН, а не пакет релиза.');if(!snapshot.releases[envelope.manifest.id])await api('/api/releases',envelope);await api('/api/releases/'+envelope.manifest.id+'/package',form.get('zip'),'PUT','application/zip');say('Релиз загружен и проверен.');});};
$('rollout-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target));const ids=[...$('nodes').querySelectorAll('input:checked')].map(b=>b.closest('tr').children[1].textContent.split(' / ')[0]);const r=await api('/api/rollouts',{release_id:f.release_id,node_ids:ids,batch_size:Number(f.batch_size),canary_count:Number(f.canary_count),start_at:new Date(f.start_at).toISOString(),end_at:new Date(f.end_at).toISOString()});say('Раскатка создана: '+r.id);});};
const localDate=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
$('rollout-form').elements.start_at.value=localDate(new Date());$('rollout-form').elements.end_at.value=localDate(new Date(Date.now()+86400000));
let configPreview=null;
function selectedNodes(){return [...$('nodes').querySelectorAll('input:checked')].map(e=>e.dataset.nodeId);}
function options(id,items,emptyLabel){const select=$(id),old=select.value;select.replaceChildren();if(emptyLabel!==undefined){const e=text('option',emptyLabel);e.value='';select.append(e);}for(const [value,label] of items){const o=text('option',label);o.value=value;select.append(o);}if([...select.options].some(o=>o.value===old))select.value=old;}
function drawConfiguration(){
 $('config-status').textContent=snapshot.configuration_enabled?'Хранилище секретов открыто.':'Настройте FLEET_MASTER_KEY_FILE на сервере, чтобы включить конфигурации.';
 $('secret-list').textContent=Object.values(snapshot.secrets||{}).map(s=>s.id+' (версия '+s.revision+')').join('; ')||'Секретов пока нет';
 const profiles=Object.values(snapshot.profiles||{}).map(p=>[p.id,p.name+' / '+p.id+' (v'+p.revision+')']);
 options('metadata-node',Object.values(snapshot.nodes).map(n=>[n.id,n.id+' / '+n.un_id]));if($('node-metadata-form').dataset.nodeId!==$('metadata-node').value)$('metadata-node').onchange?.();
 options('profile-open',profiles,'Новый профиль');options('config-profile',profiles,'Без общего профиля');options('config-node',Object.values(snapshot.nodes).filter(n=>!n.revoked).map(n=>[n.id,n.id+' / '+n.un_id]));
 if($('configuration-form').dataset.nodeId!==$('config-node').value)$('config-node').onchange?.();
}
$('metadata-node').onchange=()=>{const n=snapshot.nodes[$('metadata-node').value];if(!n)return;const form=$('node-metadata-form');form.dataset.nodeId=n.id;form.dataset.revision=n.metadata_revision||0;for(const k of ['display_name','network_address','rdp_address','api_address'])form.elements[k].value=n[k]||'';};
$('node-metadata-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target)),id=f.node_id;delete f.node_id;f.expected_revision=Number(e.target.dataset.revision);await api('/api/nodes/'+id,f,'PUT');e.target.dataset.nodeId='';say('Адреса сохранены для '+id);});};
$('profile-open').onchange=()=>{const p=snapshot.profiles[$('profile-open').value];if(!p){$('profile-form').reset();delete $('profile-form').dataset.profileId;delete $('profile-form').dataset.revision;return;}const form=$('profile-form'),f=form.elements;form.dataset.profileId=p.id;form.dataset.revision=p.revision;f.id.value=p.id;f.name.value=p.name;f.env.value=JSON.stringify(p.env,null,2);f.secret_refs.value=JSON.stringify(p.secret_refs,null,2);f.bootstrap.value=JSON.stringify(p.bootstrap||{},null,2);};
$('config-node').onchange=()=>{const n=snapshot.nodes[$('config-node').value],c=n?.configuration||{},form=$('configuration-form'),f=form.elements;form.dataset.nodeId=n?.id||'';form.dataset.revision=c.revision||0;f.profile_id.value=c.profile_id||'';f.env.value=JSON.stringify(c.env||{},null,2);f.secret_refs.value=JSON.stringify(c.secret_refs||{},null,2);for(const k of ['host','worker_account','windows_username','windows_password_ref','project_path','env_file'])f[k].value=c.bootstrap?.[k]||(['project_path','env_file'].includes(k)?(k==='project_path'?'C:/script_factory':'C:/script_factory/.env'):'');};
$('secret-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target));if(snapshot.secrets[f.id])f.expected_revision=snapshot.secrets[f.id].revision;await api('/api/config/secrets',f);e.target.elements.value.value='';configPreview=null;say('Секрет сохранён; значение повторно не показывается.');});};
$('profile-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target));f.env=JSON.parse(f.env);f.secret_refs=JSON.parse(f.secret_refs);f.bootstrap=JSON.parse(f.bootstrap);if(snapshot.profiles[f.id]){if(e.target.dataset.profileId!==f.id)throw new Error('Сначала откройте существующий профиль');f.expected_revision=Number(e.target.dataset.revision);}const saved=await api('/api/config/profiles',f);e.target.dataset.profileId=saved.id;e.target.dataset.revision=saved.revision;configPreview=null;say('Профиль сохранён. Для работающих УН требуется отдельное применение.');});};
$('configuration-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target)),n=snapshot.nodes[f.node_id];const body={profile_id:f.profile_id||null,env:JSON.parse(f.env),secret_refs:JSON.parse(f.secret_refs),bootstrap:Object.fromEntries(['host','worker_account','windows_username','windows_password_ref','project_path','env_file'].filter(k=>f[k]).map(k=>[k,f[k]])),...(n.configuration?{expected_revision:Number(e.target.dataset.revision)}:{})};const saved=await api('/api/nodes/'+f.node_id+'/configuration',body,'PUT');e.target.dataset.revision=saved.revision;configPreview=null;say('Карточка сохранена. UN_ID остаётся '+n.un_id);});};
$('config-assign-profile').onclick=()=>action(async()=>{const profile_id=$('profile-open').value;if(!profile_id)throw new Error('Откройте сохранённый профиль');const ids=selectedNodes();await api('/api/config/assign',{profile_id,node_ids:ids,expected_revisions:Object.fromEntries(ids.map(id=>[id,snapshot.nodes[id].configuration?.revision||0]))});configPreview=null;say('Общий профиль назначен выбранным УН; индивидуальные значения сохранены.');});
$('config-preview').onclick=()=>action(async()=>{configPreview=await api('/api/config/preview',{node_ids:selectedNodes()});$('config-preview-output').textContent=JSON.stringify(configPreview,null,2);say('Показаны желаемые значения. Текущий env проверяет агент; секреты скрыты.');});
$('configuration-rollout-form').onsubmit=e=>{e.preventDefault();action(async()=>{const ids=selectedNodes();if(!configPreview||ids.length!==configPreview.nodes.length||ids.some(id=>!configPreview.nodes.some(n=>n.node_id===id)))throw new Error('Сначала покажите настройки выбранных УН');const f=Object.fromEntries(new FormData(e.target));const r=await api('/api/config/rollouts',{node_ids:ids,expected_versions:Object.fromEntries(configPreview.nodes.map(n=>[n.node_id,{profile_revision:n.profile_revision,assignment_revision:n.assignment_revision,secret_revisions:n.secret_revisions}])),batch_size:Number(f.batch_size),canary_count:Number(f.canary_count),start_at:new Date(f.start_at).toISOString(),end_at:new Date(f.end_at).toISOString()});configPreview=null;say('Применение конфигурации создано: '+r.id);});};
$('config-bootstrap').onclick=()=>action(async()=>{if(!$('bootstrap-confirm').checked)throw new Error('Подтвердите защищённую выгрузку с паролями');const result=await api('/api/config/bootstrap',{node_ids:selectedNodes(),confirm_sensitive_export:true});const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='fleet-bootstrap.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('bootstrap-confirm').checked=false;say('Установочные данные выгружены. Храните файл в защищённом каталоге.');});
for(const field of ['start_at','end_at'])$('configuration-rollout-form').elements[field].value=$('rollout-form').elements[field].value;
for(const id of ['history-query','history-status','history-from','history-to','history-limit','event-type'])$(id).oninput=()=>{historyPages={rollouts:1,deployments:1,events:1};if(snapshot)drawHistory();};
$('history-filters').onsubmit=e=>e.preventDefault();
$('history-reset').onclick=()=>{for(const id of ['history-query','history-status','history-from','history-to','event-type'])$(id).value='';historyPages={rollouts:1,deployments:1,events:1};drawHistory();};
for(const id of ['rollouts','deployments','events']){ $(id+'-prev').onclick=()=>{historyPages[id]--;drawHistory();};$(id+'-next').onclick=()=>{historyPages[id]++;drawHistory();};}
$('window-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=Object.fromEntries(new FormData(e.target));await api('/api/rollouts/'+f.rollout_id+'/window',{start_at:new Date(f.start_at).toISOString(),end_at:new Date(f.end_at).toISOString()},'PUT');e.target.hidden=true;say('Окно изменено. Раскатка остаётся на паузе: создайте необходимые повторные попытки и нажмите «Продолжить».');});};
$('window-cancel').onclick=()=>{$('window-form').hidden=true;};
$('diagnostic-close').onclick=()=>$('operation-dialog').close();
$('diagnostic-download').onclick=()=>{if(!lastDiagnostics)return;const url=URL.createObjectURL(new Blob([JSON.stringify(lastDiagnostics,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='diagnostics-'+lastDiagnostics.operation_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
refresh().then(()=>say('Состояние обновляется каждые 10 секунд.')).catch(e=>say(e.message));
setInterval(()=>{if(!pending)refresh().catch(e=>say(e.message));},10000);
