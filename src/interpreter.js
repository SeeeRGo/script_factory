import { copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STEP_TIMEOUT_MS = 10_000;

export const ERROR_CODES = Object.freeze({
  IP_MISMATCH: 'IP_MISMATCH',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  AUTH_ERROR: 'AUTH_ERROR',
  UPLOAD_ERROR: 'UPLOAD_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  PLUGIN_NOT_RUNNING: 'PLUGIN_NOT_RUNNING'
});

export class InterpreterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'InterpreterError';
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class StepRegistry {
  #handlers = new Map();

  register(action, handler) {
    if (typeof action !== 'string' || !action.trim()) {
      throw new TypeError('Действие шага должно быть непустой строкой');
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`Обработчик ${action} должен быть функцией`);
    }
    this.#handlers.set(action, handler);
    return this;
  }

  has(action) {
    return this.#handlers.has(action);
  }

  actions() {
    return [...this.#handlers.keys()];
  }

  async execute(action, input) {
    const handler = this.#handlers.get(action);
    if (!handler) {
      throw new InterpreterError('UNKNOWN_ACTION', `Неподдерживаемое действие: ${action}`, {
        statusCode: 400,
        details: { action }
      });
    }
    return handler(input);
  }
}

function asDelay(value, fallback = 100) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new InterpreterError('CANCELLED', 'Операция отменена', { statusCode: 499 }));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new InterpreterError('CANCELLED', 'Операция отменена', { statusCode: 499 }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failWhen(params, names, code, message, options = {}) {
  if (names.some((name) => params[name] === true)) {
    throw new InterpreterError(code, params.error_message || message, options);
  }
}

async function simulate(input) {
  await abortableDelay(asDelay(
    input.step.delay_ms ?? input.step.duration_ms,
    input.params.delay_ms ?? input.params.duration_ms
  ), input.signal);
}

export function createDefaultStepRegistry(options = {}) {
  const workingDirectory = options.workingDirectory || process.cwd();
  const resolvePath = (value) => path.isAbsolute(value) ? value : path.resolve(workingDirectory, value);

  return new StepRegistry()
    .register('noop', async (input) => {
      await simulate(input);
      return { ok: true };
    })
    .register('check_ip', async (input) => {
      await simulate(input);
      const { params } = input;
      const currentIp = params.current_ip ?? input.context.current_ip;
      if (params.expected_ip && currentIp && params.expected_ip !== currentIp) {
        throw new InterpreterError(ERROR_CODES.IP_MISMATCH, `Ожидался IP ${params.expected_ip}, получен ${currentIp}`, {
          statusCode: 400,
          details: { expected_ip: params.expected_ip, current_ip: currentIp }
        });
      }
      return { current_ip: currentIp ?? params.expected_ip ?? null };
    })
    .register('launch_browser', async (input) => {
      failWhen(input.params, ['fail', 'launch_failed'], ERROR_CODES.AUTH_ERROR, 'Не удалось запустить браузер');
      await simulate(input);
      return { browser_launched: true, browser: input.params.browser ?? 'chromium' };
    })
    .register('navigate', async (input) => {
      failWhen(input.params, ['fail', 'navigation_failed'], ERROR_CODES.AUTH_ERROR, 'Ошибка перехода в браузере', { retryable: true });
      await simulate(input);
      return { current_url: input.params.url ?? input.context.current_url ?? null };
    })
    .register('auth_ecp', async (input) => {
      if (input.params.plugin_running === false || input.attempt <= Number(input.params.fail_attempts || 0)) {
        throw new InterpreterError(ERROR_CODES.PLUGIN_NOT_RUNNING, 'СБИС Плагин не запущен', {
          statusCode: 503,
          retryable: true,
          details: { attempt: input.attempt }
        });
      }
      if (input.params.authenticated === false || input.params.fail === true) {
        throw new InterpreterError(ERROR_CODES.AUTH_ERROR, input.params.error_message || 'Не удалось выполнить авторизацию по ЭЦП', {
          statusCode: 401
        });
      }
      await simulate(input);
      return { authenticated: true };
    })
    .register('find_files', async (input) => {
      await simulate(input);
      let files = input.params.files ?? input.context.found_files;
      if (!Array.isArray(files) && typeof input.params.directory === 'string') {
        const directory = resolvePath(input.params.directory);
        const prefixes = Array.isArray(input.params.prefixes)
          ? input.params.prefixes
          : input.params.prefixes ? [input.params.prefixes] : [];
        try {
          const entries = await readdir(directory, { withFileTypes: true });
          files = entries
            .filter((entry) => entry.isFile())
            .filter((entry) => prefixes.length === 0 || prefixes.some((prefix) => entry.name.startsWith(prefix)))
            .map((entry) => path.join(directory, entry.name))
            .sort();
        } catch (error) {
          if (error?.code === 'ENOENT') files = [];
          else {
            throw new InterpreterError(ERROR_CODES.FILE_NOT_FOUND, 'Не удалось прочитать каталог с отчётами', {
              statusCode: 404,
              details: { directory, cause: error?.code }
            });
          }
        }
      }
      if (!Array.isArray(files) || files.length === 0) {
        throw new InterpreterError(ERROR_CODES.FILE_NOT_FOUND, 'Подходящие файлы не найдены', { statusCode: 404 });
      }
      return { found_files: files, files_found: files.length };
    })
    .register('upload_files', async (input) => {
      failWhen(input.params, ['fail', 'upload_failed'], ERROR_CODES.UPLOAD_ERROR, 'Не удалось загрузить файлы', {
        statusCode: 502,
        retryable: true
      });
      const files = input.params.files ?? input.context.found_files;
      if (!Array.isArray(files) || files.length === 0) {
        throw new InterpreterError(ERROR_CODES.FILE_NOT_FOUND, 'Нет файлов для загрузки', { statusCode: 404 });
      }
      await simulate(input);
      return { uploaded_files: files, files_uploaded: files.length };
    })
    .register('validate_report', async (input) => {
      await simulate(input);
      if (input.params.valid === false || input.params.passed === false || input.params.fail === true) {
        throw new InterpreterError(ERROR_CODES.VALIDATION_ERROR, input.params.error_message || 'Отчёт не прошёл проверку', {
          statusCode: 422,
          details: { protocol: input.params.protocol ?? null }
        });
      }
      return { report_valid: true, validation_protocol: input.params.protocol ?? null };
    })
    .register('submit_if_valid', async (input) => {
      if (input.params.valid === false || input.context.report_valid === false) {
        throw new InterpreterError(ERROR_CODES.VALIDATION_ERROR, 'Отчёт нельзя отправить до успешной проверки', {
          statusCode: 422
        });
      }
      failWhen(input.params, ['fail', 'submit_failed'], ERROR_CODES.UPLOAD_ERROR, 'Не удалось отправить отчёт', {
        statusCode: 502,
        retryable: true
      });
      await simulate(input);
      return { submitted: true, submitted_at: new Date().toISOString() };
    })
    .register('move_files', async (input) => {
      failWhen(input.params, ['fail', 'move_failed'], ERROR_CODES.UPLOAD_ERROR, 'Не удалось переместить обработанные файлы');
      const files = input.params.files ?? input.context.found_files ?? [];
      await simulate(input);
      const loadedDir = input.params.destination ?? input.context.loaded_dir ?? null;
      let movedFiles = files;
      if (loadedDir && input.params.simulate !== true && files.length > 0 && files.every((file) => path.isAbsolute(file))) {
        const destination = resolvePath(loadedDir);
        await mkdir(destination, { recursive: true });
        movedFiles = [];
        for (const file of files) {
          const target = path.join(destination, path.basename(file));
          try {
            await rename(file, target);
          } catch (error) {
            if (error?.code === 'EXDEV') {
              await copyFile(file, target);
              await unlink(file);
            } else if (error?.code === 'ENOENT') {
              throw new InterpreterError(ERROR_CODES.FILE_NOT_FOUND, `Файл не найден: ${file}`, {
                statusCode: 404,
                details: { file }
              });
            } else {
              throw new InterpreterError(ERROR_CODES.UPLOAD_ERROR, 'Не удалось переместить обработанные файлы', {
                statusCode: 500,
                retryable: error?.code === 'EBUSY',
                details: { file, target, cause: error?.code }
              });
            }
          }
          movedFiles.push(target);
        }
      }
      return { moved_files: movedFiles, loaded_dir: loadedDir };
    });
}

export function resolveTemplates(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]));
  }
  if (typeof value !== 'string') return value;

  const exact = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (exact) return lookupContext(context, exact[1]);

  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const resolved = lookupContext(context, key);
    if (resolved === undefined || resolved === null) return '';
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function lookupContext(context, key) {
  return key.split('.').reduce((value, part) => value?.[part], context);
}

export function validateScript(script, registry = createDefaultStepRegistry()) {
  const errors = [];
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    return [{ path: 'script', message: 'script должен быть объектом' }];
  }
  if (!Array.isArray(script.steps)) {
    return [{ path: 'script.steps', message: 'steps должен быть массивом' }];
  }
  if (script.context !== undefined && (!script.context || typeof script.context !== 'object' || Array.isArray(script.context))) {
    errors.push({ path: 'script.context', message: 'context должен быть объектом' });
  }
  if (script.default_step_timeout_ms !== undefined
    && (!Number.isInteger(script.default_step_timeout_ms) || script.default_step_timeout_ms < 1)) {
    errors.push({ path: 'script.default_step_timeout_ms', message: 'default_step_timeout_ms должен быть положительным целым числом' });
  }

  script.steps.forEach((step, index) => {
    const path = `script.steps[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push({ path, message: 'шаг должен быть объектом' });
      return;
    }
    if (typeof step.action !== 'string' || !step.action.trim()) {
      errors.push({ path: `${path}.action`, message: 'action должен быть непустой строкой' });
    } else if (!registry.has(step.action)) {
      errors.push({ path: `${path}.action`, message: `неподдерживаемое действие: ${step.action}` });
    }
    if (step.params !== undefined && (!step.params || typeof step.params !== 'object' || Array.isArray(step.params))) {
      errors.push({ path: `${path}.params`, message: 'params должен быть объектом' });
    }
    if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 1)) {
      errors.push({ path: `${path}.timeout_ms`, message: 'timeout_ms должен быть положительным целым числом' });
    }
    if (step.duration_ms !== undefined && (!Number.isFinite(step.duration_ms) || step.duration_ms < 0)) {
      errors.push({ path: `${path}.duration_ms`, message: 'duration_ms должен быть неотрицательным числом' });
    }
    if (step.delay_ms !== undefined && (!Number.isFinite(step.delay_ms) || step.delay_ms < 0)) {
      errors.push({ path: `${path}.delay_ms`, message: 'delay_ms должен быть неотрицательным числом' });
    }
  });
  return errors;
}

function normalizeError(error) {
  if (error instanceof InterpreterError) return error;
  return new InterpreterError(error?.code || 'INTERNAL_ERROR', error?.message || 'Непредвиденная ошибка интерпретатора', {
    cause: error,
    statusCode: error?.statusCode ?? 500,
    retryable: error?.retryable ?? false,
    details: error?.details
  });
}

function stepWithTimeout(registry, action, input, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const timer = setTimeout(() => {
    controller.abort(new InterpreterError(ERROR_CODES.TIMEOUT_ERROR, `Шаг ${action} превысил тайм-аут ${timeoutMs} мс`, {
      statusCode: 408,
      retryable: true,
      details: { action, timeout_ms: timeoutMs }
    }));
  }, timeoutMs);

  return registry.execute(action, { ...input, signal: controller.signal })
    .catch((error) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    });
}

export async function executeScript(options) {
  const {
    script,
    signal,
    registry = createDefaultStepRegistry(),
    defaultStepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    initialContext = {},
    attempt = 1,
    onEvent = () => {}
  } = options;

  const validationErrors = validateScript(script, registry);
  if (validationErrors.length) {
    throw new InterpreterError('INVALID_SCRIPT', 'Сценарий не прошёл проверку', {
      statusCode: 400,
      details: { errors: validationErrors }
    });
  }

  const context = { ...(script.context ?? {}), ...initialContext };
  const startedAt = Date.now();
  await onEvent({ type: 'script_started', ts: new Date().toISOString(), total_steps: script.steps.length });

  for (let index = 0; index < script.steps.length; index += 1) {
    const step = script.steps[index];
    const action = step.action;
    const params = resolveTemplates(step.params ?? {}, context);
    const timeoutMs = step.timeout_ms ?? script.default_step_timeout_ms ?? defaultStepTimeoutMs;
    const stepStartedAt = Date.now();
    await onEvent({
      type: 'step_started',
      ts: new Date().toISOString(),
      step_index: index,
      step_id: step.id ?? `step_${index + 1}`,
      action,
      params
    });

    try {
      const output = await stepWithTimeout(registry, action, { step, params, context, signal, attempt }, timeoutMs);
      if (output && typeof output === 'object') Object.assign(context, output);
      await onEvent({
        type: 'step_completed',
        ts: new Date().toISOString(),
        step_index: index,
        step_id: step.id ?? `step_${index + 1}`,
        action,
        duration_ms: Date.now() - stepStartedAt,
        output: output ?? null
      });
    } catch (rawError) {
      const error = normalizeError(rawError);
      error.step_index = index + 1;
      error.action = action;
      error.details = {
        ...(error.details || {}),
        step_index: index + 1,
        action
      };
      await onEvent({
        type: 'step_failed',
        ts: new Date().toISOString(),
        step_index: index,
        step_id: step.id ?? `step_${index + 1}`,
        action,
        duration_ms: Date.now() - stepStartedAt,
        error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
      });
      throw error;
    }
  }

  const result = {
    steps_executed: script.steps.length,
    duration_ms: Date.now() - startedAt,
    context
  };
  await onEvent({ type: 'script_completed', ts: new Date().toISOString(), result });
  return result;
}
