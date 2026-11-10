import { executeJsonWorkflow } from './json-workflow.js';
import { executeBrowserReplay, openFileInBrowser } from './browser-replay.js';
import { executeScript, createDefaultStepRegistry, isPuppeteerReplayScript, abortableDelay } from './interpreter.js';

export async function runJobRuntime({script,context={},attempt=1,timeoutMs,allowedRoots,artifactDirectory,publicArtifactBasePath,jobId,signal,onEvent=()=>{},onBrowserLog=()=>{},serviceBaseUrl}) {
  const replay=isPuppeteerReplayScript(script),workflow=script.format==='json-workflow';
  const common={script,signal,allowedRoots,artifactDirectory,publicArtifactBasePath,jobId,onEvent,onBrowserLog,
    executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,headless:process.env.BROWSER_HEADLESS!=='false'};
  if(workflow)return executeJsonWorkflow({...common,context});
  const runtimeContext={demo_mail_url:`${serviceBaseUrl}/demo/mail`,mail_login:process.env.DEMO_MAIL_LOGIN||'demo.user',mail_password:process.env.DEMO_MAIL_PASSWORD||'demo-password',yahoo_mail_url:process.env.YAHOO_MAIL_URL||'https://login.yahoo.com/?src=ym&activity=header-signin',yahoo_login:process.env.YAHOO_MAIL_LOGIN||'seeergo@yahoo.com',yahoo_password:process.env.YAHOO_MAIL_PASSWORD||'',mail_to:process.env.YAHOO_MAIL_RECIPIENT||'10sydneyfc@gmail.com',...context};
  if(replay&&JSON.stringify(script).includes('{{yahoo_password}}')&&!runtimeContext.yahoo_password)throw Object.assign(new Error('Для отправки через Yahoo задайте YAHOO_MAIL_PASSWORD в .env'),{code:'MISSING_SECRET',retryable:false});
  if(replay)return executeBrowserReplay({...common,context:runtimeContext,timeoutMs,stepDelayMs:process.env.BROWSER_STEP_DELAY_MS,holdOpenMs:process.env.BROWSER_HOLD_OPEN_MS,captchaWaitMs:process.env.BROWSER_CAPTCHA_WAIT_MS,windowWidth:process.env.BROWSER_WINDOW_WIDTH,windowHeight:process.env.BROWSER_WINDOW_HEIGHT});
  const steps=Array.isArray(script.steps)?script.steps:[];
  const result=await executeScript({script:{...script,steps},signal,
    registry:createDefaultStepRegistry({allowedRoots,artifactDirectory,publicArtifactBasePath,downloadBaseUrl:serviceBaseUrl,
      openFile:({file,signal})=>openFileInBrowser({...common,filePath:file,signal,holdOpenMs:process.env.BROWSER_HOLD_OPEN_MS,windowWidth:process.env.BROWSER_WINDOW_WIDTH,windowHeight:process.env.BROWSER_WINDOW_HEIGHT})}),
    defaultStepTimeoutMs:Math.min(timeoutMs,10000),initialContext:{service_base_url:serviceBaseUrl,demo_file_url:`${serviceBaseUrl}/demo/files/stage4-download-demo.html`,...context},attempt,onEvent});
  const delay=Number.isFinite(script.simulate?.delay_ms)?script.simulate.delay_ms:250;
  if(!steps.length&&delay>0)await abortableDelay(delay,signal);
  const fail=(code,message,retryable=false)=>{throw Object.assign(new Error(message),{code,retryable});};
  if(script.simulate?.outcome==='validation_failed')fail('VALIDATION_ERROR','Имитация ошибки проверки');
  if(script.simulate?.outcome==='timeout')await abortableDelay(timeoutMs+50,signal);
  if(script.simulate?.outcome==='retry_once'&&attempt===1)fail('PLUGIN_NOT_RUNNING','Временная ошибка СБИС Плагина',true);
  return result;
}
