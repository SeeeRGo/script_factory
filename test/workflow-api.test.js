import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

test('dynamic workflow steps and result survive an API worker restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-api-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, callbackOrigin;
  const callbackEvents = [];
  const stop = async () => { if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; } };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore',
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), API_KEY: 'workflow-test-key', UN_ID: 'workflow-test', WEB_LOGIN: 'test', WEB_PASSWORD: 'test', DATA_DIR: root, FILESYSTEM_ALLOWED_ROOTS: root, CALLBACK_ALLOWED_ORIGINS: callbackOrigin, CALLBACK_AUTH_TOKEN: '', CALLBACK_AUTH_USERNAME: '', CALLBACK_AUTH_PASSWORD: '' } });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not start');
  };
  const request = async (url, body) => fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { 'X-API-Key': 'workflow-test-key', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const receiver = createHttpServer((req,res) => {
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{callbackEvents.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));res.end('ok');});
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  callbackOrigin=`http://127.0.0.1:${receiver.address().port}`;
  t.after(()=>new Promise(resolve=>receiver.close(resolve)));
  await start();
  const script = { format: 'json-workflow', steps: [
    { action: 'for_each', as: 'item', params: { items: [1, 2] }, steps: [{ action: 'wait', id: 'nested_wait', params: { duration_ms: 1 }, title: 'nested item' }] },
    { action: 'set', params: { result: { ok: true } } }
  ], output: { Rezult_1: '{{result}}' } };
  const response = await request('/api/v2/jobs', { script, timeout_ms: 5000 });
  assert.equal(response.status, 201);
  const id = (await response.json()).job.job_id;
  let job;
  const deadline = Date.now() + 5000;
  do {
    job = (await (await request(`/api/v2/jobs/${id}`)).json()).job;
    if (job.status === 'success') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(job.status, 'success');
  assert.equal(job.execution.steps.length, 4);
  await stop();
  await start();
  const restored = (await (await request(`/api/v2/jobs/${id}`)).json()).job;
  assert.equal(restored.execution.steps.length, 4);
  assert.equal(restored.execution.completed_steps, 4);
  assert.equal(restored.execution.steps.filter(step => step.title === 'nested item').length, 2);
  assert.deepEqual(restored.result.Rezult_1, { ok: true });
  const restoredSteps = restored.execution.steps.filter(step => step.id === 'nested_wait');
  assert.ok(restoredSteps.every(step => step.source_path === 'steps[0].steps[0]'));
  const logs = await (await request(`/api/v2/jobs/${id}/logs`)).json();
  const started = logs.logs.find(entry => entry.details?.step_id === 'nested_wait');
  assert.equal(started.details.step_title, 'nested item');
  assert.equal(started.details.source_path, 'steps[0].steps[0]');

  const waitJob = async id => {
    for (let n = 0; n < 150; n++) {
      const value = (await (await request(`/api/v2/jobs/${id}`)).json()).job;
      if (['success', 'failed', 'timeout', 'validation_failed'].includes(value.status)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('Job did not finish');
  };
  const failedResponse = await request('/api/v2/jobs', { script: { format: 'json-workflow', steps: [
    { id: 'failed_check', title: 'Verify condition', action: 'assert', params: { condition: false } }
  ] } });
  const failed = await waitJob((await failedResponse.json()).job.job_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.step_id, 'failed_check');
  assert.equal(failed.error.message, 'Шаг «Verify condition»: Условие не выполнено');
  assert.equal(failed.error.source_path, 'steps[0]');
  const failedLogs = await (await request(`/api/v2/jobs/${failed.job_id}/logs`)).json();
  const failedEntry = failedLogs.logs.find(entry => entry.level === 'error' && entry.details?.step_id === 'failed_check');
  assert.equal(failedEntry.details.step_title, 'Verify condition');
  assert.equal(failedEntry.details.error.message, failed.error.message);
  assert.equal(failedEntry.details.source_path, 'steps[0]');

  const incoming = path.join(root, 'incoming'); await mkdir(incoming);
  const emptyScript = JSON.parse(await readFile(new URL('../demo/sbis-report-full.json', import.meta.url), 'utf8'));
  const emptyResponse = await request('/api/v2/jobs', { script: emptyScript, context: {
    inn: '1234567890', mode: 'send', submit_enabled: true, root_dir: incoming,
    authority_prefixes: [{ authority: 'FNS', prefixes: ['NO_'] }, { authority: 'SFR', prefixes: ['POVD'] }]
  } });
  assert.equal(emptyResponse.status, 201);
  const empty = await waitJob((await emptyResponse.json()).job.job_id);
  assert.equal(empty.status, 'success');
  assert.deepEqual(Object.keys(empty.result).filter(k => /^Rezult_/.test(k)), []);
  assert.deepEqual(empty.result.artifacts, []);

  const details = 'Главная\nНекорректно указано лицо, подписывающее документ\nДля отчёта ИП удалите ФИО руководителя';
  const protocolScript = {
    format:'json-workflow', context:{ mode:'validate_only',inn:'1234567890' },
    routines:{project_results:emptyScript.routines.project_results},
    steps:[
      {action:'artifact_write',params:{filename:'validation-report.txt',text:details},save_as:'protocol'},
      {action:'set',params:{reports:[{path:'/incoming/NO_report.xml',filename:'NO_report.xml',sha256:'test-only',authority:'FNS',state:'validation_failed',validation_result:'Найденные ошибки',validation_error_text:details,protocol:'{{protocol}}'}]}},
      {action:'call',routine:'project_results'},
      {action:'fail',title:'Проверить отчёт',params:{error_code:'VALIDATION_ERROR',message:details}}
    ],on_error:[{action:'call',routine:'project_results'}],output:'{{report_results}}'
  };
  const protocolResponse=await request('/api/v2/jobs',{script:protocolScript,callback:{url:callbackOrigin+'/result',max_attempts:1}});
  assert.equal(protocolResponse.status,201);
  const protocolJob=await waitJob((await protocolResponse.json()).job.job_id);
  assert.equal(protocolJob.status,'validation_failed');
  assert.equal(protocolJob.result.Rezult_1.error_message,details);
  assert.equal(protocolJob.result.Rezult_1.error_code,'VALIDATION_ERROR');
  assert.ok(protocolJob.error.message.includes(details));
  const protocolArtifact=protocolJob.result.artifacts.find(a=>a.filename==='validation-report.txt');
  assert.ok(protocolArtifact);assert.equal(await (await request(protocolArtifact.api_url)).text(),details);
  for(let i=0;i<100&&!callbackEvents.some(e=>e.job.job_id===protocolJob.job_id);i++)await new Promise(resolve=>setTimeout(resolve,20));
  const event=callbackEvents.find(e=>e.job.job_id===protocolJob.job_id);
  assert.ok(event);assert.equal(event.job.result.Rezult_1.error_message,details);
  assert.equal(event.job.error.message,protocolJob.error.message);
  await stop();await start();
  const restoredProtocol=(await(await request('/api/v2/jobs/'+protocolJob.job_id)).json()).job;
  assert.equal(restoredProtocol.result.Rezult_1.error_message,details);
  assert.equal(await(await request(protocolArtifact.api_url)).text(),details);

});
