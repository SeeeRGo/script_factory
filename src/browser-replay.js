import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRunner, parse, PuppeteerRunnerExtension } from '@puppeteer/replay';
import puppeteer from 'puppeteer';
import { InterpreterError, resolveTemplates } from './interpreter.js';

const DEFAULT_REPLAY_TIMEOUT_MS = 10_000;
const EXECUTABLE_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'];

async function existingExecutablePath(configuredPath) {
  const candidates = [configuredPath, ...EXECUTABLE_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known executable.
    }
  }
  try {
    return puppeteer.executablePath();
  } catch {
    return undefined;
  }
}

function replayError(rawError, extension) {
  if (rawError instanceof InterpreterError) return rawError;
  const aborted = extension.signal?.aborted;
  if (aborted) {
    const reason = extension.signal.reason;
    if (reason instanceof Error) return reason;
    return new InterpreterError('CANCELLED', 'Выполнение браузерного сценария отменено', { statusCode: 499 });
  }
  const error = new InterpreterError('BROWSER_REPLAY_ERROR', rawError?.message || 'Ошибка выполнения Puppeteer Replay', {
    cause: rawError,
    statusCode: 500,
    retryable: false,
    details: {
      step_index: extension.currentIndex + 1,
      action: extension.currentStep?.type ?? 'unknown'
    }
  });
  error.step_index = extension.currentIndex + 1;
  error.action = extension.currentStep?.type ?? 'unknown';
  return error;
}

function eventParams(step) {
  const { type, ...params } = step;
  if (type !== 'change') return params;
  const selectorText = JSON.stringify(step.selectors || []);
  if (!/(pass(word)?|парол|secret|token|credential)/i.test(selectorText)) return params;
  return { ...params, value: '••••••' };
}

function redactText(value, context) {
  let result = String(value ?? '');
  for (const [key, secret] of Object.entries(context)) {
    if (!/(pass(word)?|парол|secret|token|credential)/i.test(key)) continue;
    if (typeof secret === 'string' && secret) result = result.replaceAll(secret, '••••••');
  }
  return result;
}

async function pageSnapshot(page) {
  if (!page || page.isClosed()) return { current_url: null, page_title: null };
  let pageTitle = null;
  try {
    pageTitle = await page.title();
  } catch {
    // The page can close as part of a valid recording.
  }
  return { current_url: page.url(), page_title: pageTitle };
}

async function screenshotArtifact(page, artifactDirectory, publicBasePath, jobId, suffix) {
  if (!page || page.isClosed()) return null;
  await mkdir(artifactDirectory, { recursive: true });
  const filename = `${suffix}.png`;
  const localPath = path.join(artifactDirectory, filename);
  await page.screenshot({ path: localPath, fullPage: true });
  const fileStat = await stat(localPath);
  return {
    artifact_id: `${jobId}_${suffix}`,
    kind: 'browser_screenshot',
    filename,
    local_path: localPath,
    public_url: `${publicBasePath}/${encodeURIComponent(filename)}`,
    source_url: null,
    mime_type: 'image/png',
    size_bytes: fileStat.size,
    checksum_sha256: null,
    created_at: new Date().toISOString()
  };
}

class ObservableReplayExtension extends PuppeteerRunnerExtension {
  constructor(browser, page, options) {
    super(browser, page, { timeout: options.timeoutMs });
    this.onEvent = options.onEvent;
    this.signal = options.signal;
    this.startedAt = 0;
    this.currentIndex = -1;
    this.currentStep = null;
    this.currentStepStartedAt = 0;
    this.completedSteps = 0;
  }

  async beforeAllSteps(flow) {
    this.startedAt = Date.now();
    await this.onEvent({
      type: 'script_started',
      ts: new Date().toISOString(),
      total_steps: flow.steps.length,
      runtime: 'puppeteer-replay',
      title: flow.title
    });
  }

  async beforeEachStep(step) {
    if (this.signal?.aborted) throw this.signal.reason;
    this.currentIndex += 1;
    this.currentStep = step;
    this.currentStepStartedAt = Date.now();
    await this.onEvent({
      type: 'step_started',
      ts: new Date().toISOString(),
      step_index: this.currentIndex,
      step_id: `replay_${this.currentIndex + 1}`,
      action: step.type,
      params: eventParams(step)
    });
  }

  async afterEachStep(step) {
    const output = await pageSnapshot(this.page);
    this.completedSteps += 1;
    await this.onEvent({
      type: 'step_completed',
      ts: new Date().toISOString(),
      step_index: this.currentIndex,
      step_id: `replay_${this.currentIndex + 1}`,
      action: step.type,
      duration_ms: Date.now() - this.currentStepStartedAt,
      output
    });
  }
}

export async function executeBrowserReplay(options) {
  const {
    script,
    context = {},
    signal,
    onEvent = () => {},
    onBrowserLog = () => {},
    timeoutMs = DEFAULT_REPLAY_TIMEOUT_MS,
    executablePath: configuredExecutablePath,
    headless = true,
    artifactDirectory,
    publicArtifactBasePath,
    jobId
  } = options;

  let flow;
  try {
    const resolvedScript = resolveTemplates(script, context);
    flow = parse(resolvedScript);
  } catch (rawError) {
    throw new InterpreterError('BROWSER_REPLAY_ERROR', `Не удалось подготовить Puppeteer Replay: ${rawError?.message || 'неизвестная ошибка'}`, {
      cause: rawError,
      statusCode: 400,
      retryable: false
    });
  }
  if (signal?.aborted) throw signal.reason;
  const executablePath = await existingExecutablePath(configuredExecutablePath);
  let browser;
  let page;
  try {
    browser = await puppeteer.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    page = await browser.newPage();
  } catch (rawError) {
    await browser?.close().catch(() => {});
    throw new InterpreterError('BROWSER_LAUNCH_ERROR', `Не удалось запустить Chromium: ${rawError?.message || 'неизвестная ошибка'}`, {
      cause: rawError,
      statusCode: 503,
      retryable: true,
      details: { executable_path: executablePath ?? null, headless }
    });
  }
  page.on('console', (message) => onBrowserLog('debug', `Browser console: ${redactText(message.text(), context)}`));
  page.on('pageerror', (error) => onBrowserLog('warn', `Browser page error: ${redactText(error.message, context)}`));

  const extension = new ObservableReplayExtension(browser, page, {
    timeoutMs: Math.max(1, Math.min(timeoutMs, 30_000)),
    signal,
    onEvent
  });
  const runner = await createRunner(flow, extension);
  const onAbort = () => {
    runner.abort();
    void browser.close().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const completed = await runner.run();
    if (!completed || signal?.aborted) throw signal?.reason ?? new InterpreterError('CANCELLED', 'Сценарий отменён', { statusCode: 499 });
    const finalState = await pageSnapshot(page);
    const artifact = await screenshotArtifact(
      page,
      artifactDirectory,
      publicArtifactBasePath,
      jobId,
      'browser-final'
    );
    const result = {
      steps_executed: flow.steps.length,
      duration_ms: Date.now() - extension.startedAt,
      context: {
        runtime: 'puppeteer-replay',
        recording_title: flow.title,
        ...finalState,
        artifacts: artifact ? [artifact] : []
      }
    };
    await onEvent({ type: 'script_completed', ts: new Date().toISOString(), result });
    return result;
  } catch (rawError) {
    const error = replayError(rawError, extension);
    let failureArtifact = null;
    try {
      failureArtifact = await screenshotArtifact(
        page,
        artifactDirectory,
        publicArtifactBasePath,
        jobId,
        'browser-error'
      );
    } catch {
      // Preserve the original replay error if a diagnostic screenshot fails.
    }
    error.details = {
      ...(error.details || {}),
      ...(failureArtifact ? { artifact: failureArtifact } : {})
    };
    if (extension.currentIndex >= 0) {
      await onEvent({
        type: 'step_failed',
        ts: new Date().toISOString(),
        step_index: extension.currentIndex,
        step_id: `replay_${extension.currentIndex + 1}`,
        action: extension.currentStep?.type ?? 'unknown',
        duration_ms: Date.now() - extension.currentStepStartedAt,
        error: { code: error.code, message: error.message, retryable: Boolean(error.retryable), details: error.details }
      });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
