export const activeStatuses=new Set(['assigned','draining','downloading','installing','verifying']);
export const unfinishedStatuses=new Set(['queued',...activeStatuses,'recovery_required']);
export const errorStatuses=new Set(['failed','rolled_back','recovery_required']);
export const statusLabels={queued:'В очереди',assigned:'Назначено',draining:'Завершение текущих работ',downloading:'Загрузка пакета',installing:'Установка',verifying:'Проверка',succeeded:'Успешно',failed:'Ошибка',rolled_back:'Выполнен откат',recovery_required:'Требуется восстановление',superseded:'Заменено повторной попыткой',cancelled:'Отменено',running:'Выполняется',paused:'Приостановлено',completed:'Завершено'};
const explanations={INSTALL_OUTCOME_UNKNOWN:'Установщик не подтвердил результат. Проверьте локальный протокол, фактическую версию и обслуживание перед подтверждением восстановления.',UPDATE_FAILED:'Установщик завершился с ошибкой. Подробности находятся в локальном протоколе установки.',ROLLBACK_FAILED:'Автоматический откат не подтверждён. Требуется проверка УН.',HEALTH_FAILED:'После установки API не прошёл проверку готовности.',SMOKE_FAILED:'Не пройдена контрольная проверка исполнителя.',DRAIN_TIMEOUT:'Текущие задания не завершились в отведённое время.',AGENT_UNRESPONSIVE:'Агент перестал сообщать о ходе операции.',VERSION_NOT_NEWER:'Выбранная версия не новее установленной.',RECOVERY_CONFIRMED:'УН восстановлена. Обновление не считается успешным; можно создать повторную попытку.',WINDOW_EXPIRED:'Окно обновления истекло. Укажите новое окно.',RETRY_REQUIRED:'Сначала восстановите проблемные УН и создайте повторные попытки.',MAINTENANCE_RELEASE_FAILED:'Не удалось завершить обслуживание. Проверьте локальное состояние API.',SERVICE_RETURN_UNCONFIRMED:'Возвращение API в рабочий режим не подтверждено.'};
export function explainCode(code){return explanations[code]||code||'—';}
export function operationBlocker(d,s,at=Date.now()){
 const r=s.rollouts[d.rollout_id],n=s.nodes[d.node_id];
 if(d.node_deleted_at)return 'Регистрация УН удалена. Для новой регистрации создайте новую раскатку.';
 if(d.status==='recovery_required'){
  if(!n?.last_seen||at-Date.parse(n.last_seen)>180000)return 'Для подтверждения нужен свежий контакт агента (не старше 3 минут).';
  if(n.maintenance)return 'На УН включено обслуживание; сначала проверьте и восстановите её.';
  if(!n.api_ready)return 'Агент сообщает, что API не готов.';
  if((n.heartbeat_serial||0)<=(d.recovery_serial||0))return 'Ожидается новый контакт агента после ошибки.';
  return 'Связь и готовность подтверждены. Подтвердите восстановление только после проверки результата установки.';
 }
 if(d.status!=='queued')return explainCode(d.error_code);
 if(!r)return 'Не найдена раскатка.';
 if(r.status==='cancelled'||r.status==='completed')return 'Раскатка закрыта. Создайте новую раскатку.';
 if(at>Date.parse(r.end_at))return 'Окно обновления истекло. Измените окно и продолжите раскатку.';
 if(r.status==='paused')return 'Раскатка на паузе'+(r.pause_reason?' ('+explainCode(r.pause_reason)+')':'')+'.';
 if(at<Date.parse(r.start_at))return 'Ожидается начало окна: '+new Date(r.start_at).toLocaleString('ru-RU')+'.';
 if(!n?.last_seen||at-Date.parse(n.last_seen)>180000)return 'Нет свежего контакта агента. Проверьте его задачу, ключ и central_url.';
 const ds=Object.values(s.deployments).filter(x=>x.rollout_id===r.id&&x.status!=='superseded');
 if(!r.canary_ids.includes(d.node_id)&&!r.canary_ids.every(id=>ds.some(x=>x.node_id===id&&x.status==='succeeded')))return 'Ожидается успешное завершение пилотных УН.';
 if(d.retry_at&&at<Date.parse(d.retry_at))return 'Ожидается срок повторной попытки: '+new Date(d.retry_at).toLocaleString('ru-RU')+'.';
 if(ds.filter(x=>activeStatuses.has(x.status)).length>=r.batch_size)return 'Занят лимит параллельных установок этой раскатки.';
 return 'Ожидается следующий опрос агента или свободный общий слот. Обычно агент опрашивает центр раз в 30 секунд.';
}
export function historyPage(items,{query='',status='',from='',to='',limit=50,page=1}={}){
 const q=query.trim().toLocaleLowerCase('ru-RU'),start=from?Date.parse(from+'T00:00:00'):-Infinity,end=to?Date.parse(to+'T23:59:59.999'):Infinity;
 const filtered=items.filter(x=>{
  if(status==='errors'&&!errorStatuses.has(x.status)&&!(x.status==='paused'&&['DEPLOYMENT_FAILED','WINDOW_EXPIRED','AGENT_UNRESPONSIVE'].includes(x.pause_reason)))return false;
  if(status==='unfinished'&&!unfinishedStatuses.has(x.status)&&!['running','paused'].includes(x.status))return false;
  if(status==='finished'&&(unfinishedStatuses.has(x.status)||['running','paused'].includes(x.status)))return false;
  if(status&&!['errors','unfinished','finished'].includes(status)&&x.status!==status)return false;
  const at=Date.parse(x.created_at||x.at||x.assigned_at||'');
  if((from||to)&&(!Number.isFinite(at)||at<start||at>end))return false;
  return !q||JSON.stringify(x).toLocaleLowerCase('ru-RU').includes(q);
 });
 const size=Math.min(250,Math.max(1,Number(limit)||50)),pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.min(pages,Math.max(1,Number(page)||1));
 return {items:filtered.slice((current-1)*size,current*size),total:filtered.length,page:current,pages};
}
export function operationDiagnostics(d,s,at=Date.now()){
 const n=s.nodes[d.node_id],r=s.rollouts[d.rollout_id];
 const directory=n?.agent_data_dir||'C:\\ProgramData\\ScriptFactoryAgent\\data';
 const join=name=>directory.replace(/[\\/]+$/,'')+'\\'+name;
 return {operation_id:d.id,node_id:d.node_id,un_id:d.target_un_id||n?.un_id||null,address:d.target_address||n?.network_address||null,rollout_id:d.rollout_id,release_id:d.release_id,status:d.status,error_code:d.error_code||null,explanation:explainCode(d.error_code),waiting_reason:operationBlocker(d,s,at),node_deleted:!!d.node_deleted_at,node:{last_seen:n?.last_seen||null,api_ready:n?.api_ready===true,maintenance:n?.maintenance===true,version:n?.version||null},rollout:r?{status:r.status,pause_reason:r.pause_reason||null,start_at:r.start_at,end_at:r.end_at}:null,logs_location:n?.agent_data_dir?'Каталог сообщает агент':'Пути по умолчанию; при настройке другого data_dir смотрите установленный agent.config.json',local_logs:d.kind==='configuration'?[join(d.id+'.config-result.json'),join(d.id+'.config-rollback.json'),join('agent-err.log')]:[join(d.id+'.result.json.log'),join(d.id+'.result.json'),join(d.id+'.rollback.json.log'),join(d.id+'.rollback.json'),join('agent-err.log')],note:'Это сведения центра и пути к локальным файлам. Содержимое Windows-протокола хранится на самой УН и сюда не загружается.'};
}
