import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionalJson,fault } from './common.mjs';
export function windowsAdapter(config){
 const root=path.dirname(fileURLToPath(import.meta.url));
 const resultFile=command=>path.join(config.data_dir,command.deployment_id+'.result.json');
 async function run(mode,params){
  if(process.platform!=='win32')throw fault('WINDOWS_REQUIRED','The real installer runs only on Windows');
  const result=mode==='update'?resultFile(params.command):path.join(config.data_dir,params.command.deployment_id+'.rollback.json');
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'run-update.ps1'),'-Mode',mode,'-ResultFile',result,'-ProjectPath',config.project_path,'-EnvFile',config.env_file,'-TaskName',config.worker_task_name,'-TaskPath',config.worker_task_path||String.fromCharCode(92),'-Port',String(new URL(config.api_url).port||80),'-BackupRoot',config.backup_root,'-MaintenanceOwner',params.owner];
  if(mode==='update')args.push('-PackageZip',params.file,'-ExpectedVersion',params.command.release.manifest.version,'-ExpectedSha256',params.command.release.manifest.sha256);
  else args.push('-Backup',params.backup);
  const p=spawn(config.powershell_path||path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),args,{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve);});
  return await optionalJson(result,null)||{updated:false};
 }
 async function configure(mode,params){
  if(process.platform!=='win32')throw fault('WINDOWS_REQUIRED','Configuration installer requires Windows');
  const result=path.join(config.data_dir,params.command.deployment_id+(mode==='apply'?'.config-result.json':'.config-rollback.json'));
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'config-update.ps1'),'-Mode',mode,'-ResultFile',result,'-ProjectPath',config.project_path,'-EnvFile',config.env_file,'-TaskName',config.worker_task_name,'-TaskPath',config.worker_task_path||String.fromCharCode(92),'-Port',String(new URL(config.api_url).port||80),'-BackupRoot',config.backup_root,'-MaintenanceOwner',params.owner,'-UnId',config.un_id];
  if(mode==='apply')args.push('-PayloadFile',params.file);else args.push('-Backup',params.backup);
  const child=spawn(config.powershell_path||path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),args,{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  return await optionalJson(result,null)||{updated:false};
 }
 return {install:p=>run('update',p),rollback:p=>run('rollback',p),recover:active=>optionalJson(active.phase==='rolling_back'?path.join(config.data_dir,active.command.deployment_id+'.rollback.json'):resultFile(active.command),null),
  installConfiguration:p=>configure('apply',p),rollbackConfiguration:p=>configure('rollback',p),recoverConfiguration:a=>optionalJson(path.join(config.data_dir,a.command.deployment_id+(a.phase==='rolling_back'?'.config-rollback.json':'.config-result.json')),null)};
}
