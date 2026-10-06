import { Worker } from 'node:worker_threads';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createRunner, parse, PuppeteerRunnerExtension } from '@puppeteer/replay';
import { InterpreterError, resolveTemplates, abortableDelay } from './interpreter.js';
import { resolveBrowserExecutablePath, resolveBrowserUploadFiles } from './browser-replay.js';
import { checkExternalIp } from './system-checks.js';
import { validateWorkflow, workflowIdentifier } from './workflow-schema.js';
import { checkedWorkflowPath, listWorkflowFiles, verifyWorkflowFile, archiveWorkflowFile, copyWorkflowFile } from './workflow-files.js';

const fail = (code, message) => { throw new InterpreterError(code, message); };
const clone = value => JSON.parse(JSON.stringify(value));
export async function computeWorkflowExpression(expression, context) {
  if (typeof expression !== 'string' || expression.length > 100000) fail('INVALID_EXPRESSION', 'Неверное выражение');
  const data = JSON.stringify(context);
  if (data.length > 16 * 1024 * 1024) fail('WORKFLOW_LIMIT', 'Контекст слишком велик');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workflow-expression.js', import.meta.url), {
      workerData: { expression, data }, resourceLimits: { maxOldGenerationSizeMb: 64 }, execArgv: []
    });
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new InterpreterError('EXPRESSION_ERROR', 'Выражение превысило тайм-аут')), 1000);
    worker.on('message', encoded => {
      try {
        const result = JSON.parse(encoded);
        void finish(result.ok ? null : new InterpreterError(result.error.code, result.error.message), result.value ?? null);
      } catch { void finish(new InterpreterError('EXPRESSION_ERROR', 'Некорректный результат выражения')); }
    });
    worker.on('error', () => { void finish(new InterpreterError('EXPRESSION_ERROR', 'Ошибка вычисления выражения')); });
    worker.on('exit', () => { if (!settled) void finish(new InterpreterError('EXPRESSION_ERROR', 'Вычисление прервано')); });
  });
}
export async function executeJsonWorkflow(options) {
  const { script, signal, allowedRoots = [], artifactDirectory, publicArtifactBasePath = '', jobId = 'workflow', onEvent = () => {} } = options;
  const errors = validateWorkflow(script);
  if (errors.length) throw new InterpreterError('INVALID_SCRIPT', 'Некорректный JSON workflow', { details: { errors } });
  const context = clone({ ...(script.context || {}), ...(options.context || {}) });
  context.job_id = jobId;
  const startedAt = Date.now();
  let browser, page, count = 0, completed = 0;
  const artifacts = [];
  const assign = (key, value) => { if (!workflowIdentifier(key)) fail('INVALID_VARIABLE', 'Неверное имя переменной'); context[key] = value; };
  const emit = event => onEvent({ ts: new Date().toISOString(), ...event });
  const close = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  const projection = () => ({ ...(script.output ? resolveTemplates(script.output, context) : clone(context)), artifacts: [...artifacts] });
  const requirePage = () => { if (!page || page.isClosed()) fail('BROWSER_NOT_STARTED', 'Браузер не запущен'); };
  const writeArtifact = async (filename, value, mime = 'text/plain', kind = 'workflow_artifact') => {
    if (!artifactDirectory || typeof filename !== 'string' || !filename || path.basename(filename) !== filename || filename === '.' || filename === '..' || /[\\/]/.test(filename)) fail('INVALID_ARTIFACT', 'Неверное имя артефакта');
    await mkdir(artifactDirectory, { recursive: true });
    const directory = await checkedWorkflowPath(artifactDirectory, allowedRoots, true);
    const file = path.join(directory, filename);
    await writeFile(file, value, { flag: 'wx' });
    const descriptor = { artifact_id: `${jobId}_${filename}`, kind, filename, local_path: file,
      public_url: `${publicArtifactBasePath}/${encodeURIComponent(filename)}`, mime_type: mime,
      size_bytes: (await stat(file)).size, created_at: new Date().toISOString() };
    artifacts.push(descriptor);
    return descriptor;
  };
  const screenshot = async name => {
    requirePage();
    return writeArtifact(name, await page.screenshot({ fullPage: true }), 'image/png', 'browser_screenshot');
  };
  const scoped = async (values, fn) => {
    const previous = new Map(Object.keys(values).map(key => [key, Object.hasOwn(context, key) ? { value: context[key] } : null]));
    try { for (const [key, value] of Object.entries(values)) assign(key, value); return await fn(); }
    finally { for (const [key, old] of previous) { if (old) context[key] = old.value; else delete context[key]; } }
  };
  async function operation(step, params, activeSignal, depth) {
    activeSignal?.throwIfAborted();
    switch (step.action) {
      case 'set': for (const [key, value] of Object.entries(params)) assign(key, value); return null;
      case 'compute': return computeWorkflowExpression(params.expression, context);
      case 'assert': if (params.condition !== true) fail(params.error_code || 'ASSERTION_FAILED', params.message || 'Условие не выполнено'); return true;
      case 'fail': fail(params.error_code || 'WORKFLOW_FAILED', params.message || 'Сценарий остановлен'); break;
      case 'wait': await abortableDelay(params.duration_ms || 0, activeSignal); return true;
      case 'if': await run(params.condition === true ? step.then || [] : step.else || [], activeSignal, depth + 1); return null;
      case 'for_each': {
        if (!Array.isArray(params.items)) fail('INVALID_ITERATION', 'items должен быть массивом');
        if (params.items.length > 1000) fail('WORKFLOW_LIMIT', 'Слишком много итераций');
        for (const [index, item] of params.items.entries()) {
          activeSignal?.throwIfAborted();
          await scoped({ [step.as]: item, ...(step.index_as ? { [step.index_as]: index } : {}) }, () => run(step.steps, activeSignal, depth + 1));
        }
        return null;
      }
      case 'call': return scoped(params, () => run(script.routines[step.routine], activeSignal, depth + 1));
      case 'system_ip_check': return (options.checkIp || checkExternalIp)();
      case 'files_list': return listWorkflowFiles(params.directory, allowedRoots, activeSignal);
      case 'file_verify': await verifyWorkflowFile(params.file, allowedRoots); return true;
      case 'file_archive': return archiveWorkflowFile(params.file, params.directory, allowedRoots, activeSignal);
      case 'file_copy': return copyWorkflowFile(params.source, params.destination, allowedRoots, activeSignal);
      case 'artifact_write': return writeArtifact(params.filename, typeof params.text === 'string' ? params.text : JSON.stringify(params.text), params.mime_type || 'text/plain');
      case 'browser_launch': {
        if (browser) fail('BROWSER_ALREADY_STARTED', 'Сессия браузера уже существует');
        const headless = options.headless ?? true;
        browser = await puppeteer.launch({ executablePath: await resolveBrowserExecutablePath(options.executablePath), headless,
          defaultViewport: headless ? { width: 1400, height: 860 } : null,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1400,860'] });
        if (activeSignal?.aborted) { await browser.close(); throw activeSignal.reason; }
        page = (await browser.pages())[0] || await browser.newPage();
        await page.bringToFront();
        page.on('pageerror', () => {});
        for (const expression of params.init_scripts || []) await page.evaluateOnNewDocument(expression);
        return { browser_launched: true };
      }
      case 'browser_eval': {
        requirePage();
        const data = JSON.stringify(JSON.stringify(context));
        const source = `(async () => { const context = JSON.parse(${data}); try { return {ok:true,value:await (${params.expression})}; } catch(e) { return {ok:false,error:{code:String(e.code||'BROWSER_EXPRESSION_ERROR'),message:String(e.message||'Ошибка браузерного выражения')}}; } })()`;
        // A string expression is executed by Puppeteer only in the browser, never by Node.
        const result = await page.evaluate(source);
        if (!result.ok) fail(result.error.code, result.error.message);
        return result.value ?? null;
      }
      case 'browser_wait': {
        requirePage();
        try {
          const data = JSON.stringify(JSON.stringify(context));
          const source = `(() => { const context = JSON.parse(${data}); return (${params.expression}); })()`;
          const handle = await page.waitForFunction(source,
            { timeout: params.timeout_ms || script.default_step_timeout_ms || 30000, signal: activeSignal });
          try { return await handle.jsonValue(); } finally { await handle.dispose(); }
        } catch (error) { if (activeSignal?.aborted) throw activeSignal.reason; if (params.error_code) fail(params.error_code, params.message || 'Не выполнено условие ожидания'); throw error; }
      }
      case 'browser_steps': {
        requirePage();
        const recording = parse({ title: 'JSON browser steps', timeout: params.timeout_ms || 30000, steps: resolveTemplates(params.steps, context) });
        const extension = new class extends PuppeteerRunnerExtension {
          async runStepInFrame(step, main, target, frame, timeout) {
            if (step.type !== 'customStep') return super.runStepInFrame(step, main, target, frame, timeout);
            if (step.name !== 'uploadFiles') fail('INVALID_SCRIPT', 'Неизвестный customStep');
            const files = await resolveBrowserUploadFiles(step.parameters?.files, allowedRoots);
            const input = await frame.waitForSelector(step.parameters?.selector, { timeout, signal: activeSignal });
            try { await input.uploadFile(...files.map(file => file.path)); } finally { await input.dispose(); }
          }
        }(browser, page, { timeout: params.timeout_ms || 30000 });
        const runner = await createRunner(recording, extension);
        const abort = () => { runner.abort(); close(); };
        activeSignal?.addEventListener('abort', abort, { once: true });
        try { if (!await runner.run()) fail('CANCELLED', 'Браузерные шаги остановлены'); activeSignal?.throwIfAborted(); return true; }
        finally { activeSignal?.removeEventListener('abort', abort); }
      }
      case 'browser_screenshot': return screenshot(params.filename || `workflow-${count}.png`);
      default: fail('UNKNOWN_ACTION', 'Неизвестная операция');
    }
  }
  async function run(steps, parentSignal, depth = 0) {
    if (depth > 25) fail('WORKFLOW_LIMIT', 'Слишком глубокий вызов подпрограмм');
    for (const step of steps) {
      parentSignal?.throwIfAborted();
      if (count >= 10000) fail('WORKFLOW_LIMIT', 'Превышен лимит шагов');
      const index = count++, start = Date.now();
      const params = resolveTemplates(step.params || {}, context);
      const privateStep = step.private === true;
      await emit({ type: 'step_added', step_index: index, step: { ...step, params: undefined, steps: undefined, then: undefined, else: undefined } });
      await emit({ type: 'step_started', step_index: index, step_id: step.id || `step_${index + 1}`, action: step.action, params: privateStep ? { redacted: true } : params });
      const controller = new AbortController();
      const abort = () => controller.abort(parentSignal.reason);
      parentSignal?.addEventListener('abort', abort, { once: true });
      if (parentSignal?.aborted) abort();
      const control = ['if', 'for_each', 'call'].includes(step.action);
      const timeout = step.timeout_ms === undefined ? (control ? null : script.default_step_timeout_ms || 60000) : resolveTemplates(step.timeout_ms, context);
      const timer = Number.isInteger(timeout) && timeout > 0 ? setTimeout(() => controller.abort(new InterpreterError('TIMEOUT_ERROR', 'Шаг превысил тайм-аут', { statusCode: 408 })), timeout) : null;
      const abortBrowser = () => close();
      controller.signal.addEventListener('abort', abortBrowser, { once: true });
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
      try {
        if (timeout !== null && (!Number.isInteger(timeout) || timeout < 1)) fail('INVALID_TIMEOUT', 'Неверный тайм-аут шага');
        const output = await Promise.race([operation(step, params, controller.signal, depth), aborted]);
        controller.signal.throwIfAborted();
        if (step.save_as) assign(step.save_as, output);
        completed++;
        await emit({ type: 'step_completed', step_index: index, step_id: step.id || `step_${index + 1}`, action: step.action,
          duration_ms: Date.now() - start, output: privateStep ? { redacted: true } : output });
      } catch (raw) {
        const error = raw instanceof InterpreterError ? raw : new InterpreterError(raw?.code || 'WORKFLOW_ERROR', raw?.message || 'Ошибка выполнения');
        error.retryable = false;
        error.step_index ??= index + 1;
        error.action ??= step.action;
        await emit({ type: 'step_failed', step_index: index, action: step.action, duration_ms: Date.now() - start,
          error: { code: error.code, message: error.message, retryable: false } });
        throw error;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', abortBrowser);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    }
  }
  await emit({ type: 'script_started', execution_steps: [], total_steps: 0, runtime: 'json-workflow' });
  try {
    await run(script.steps, signal);
    const result = { steps_executed: completed, duration_ms: Date.now() - startedAt, context: projection() };
    await emit({ type: 'script_completed', result });
    return result;
  } catch (error) {
    context.error = { code: error.code || 'WORKFLOW_ERROR', message: error.message || 'Ошибка выполнения' };
    // An aborted job must never execute further browser or file actions.
    if (!signal?.aborted && script.on_error) { try { await run(script.on_error, signal); } catch { /* Preserve the original error. */ } }
    try { if (page && !page.isClosed()) await screenshot('workflow-error.png'); } catch { /* Preserve the original error. */ }
    error.partial_context = projection();
    error.retryable = false;
    throw error;
  } finally {
    signal?.removeEventListener('abort', close);
    await browser?.close().catch(() => {});
  }
}
