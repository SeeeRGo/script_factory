import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const executeFile = promisify(execFile);
export const powerError = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const bounds = { user_idle_seconds: [1, 2592000], check_interval_seconds: [5, 86400], grace_seconds: [0, 3600], resume_cooldown_seconds: [1, 86400] };
const booleanKeys = ['enabled', 'background_enabled', 'dry_run'];
export function validatePowerConfig(value, base = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw powerError('INVALID_POWER_CONFIG', 'Настройки должны быть объектом');
  for (const [key, item] of Object.entries(value)) {
    if (booleanKeys.includes(key)) { if (typeof item !== 'boolean') throw powerError('INVALID_POWER_CONFIG', `${key}: требуется Boolean`); }
    else if (Object.hasOwn(bounds, key)) {
      const [min, max] = bounds[key];
      if (!Number.isInteger(item) || item < min || item > max) throw powerError('INVALID_POWER_CONFIG', `${key}: требуется целое число ${min}..${max}`);
    } else if (key === 'mode') {
      if (!['sleep', 'hibernate'].includes(item)) throw powerError('INVALID_POWER_CONFIG', 'mode: требуется sleep или hibernate');
    } else if (key === 'excluded_user') {
      if (typeof item !== 'string' || !item.trim() || item.length > 256 || /^[\s-]|[\x00-\x1f"'`;|<>]/.test(item)) throw powerError('INVALID_POWER_CONFIG', 'excluded_user: требуется имя Windows-пользователя, желательно DOMAIN\\User');
    } else throw powerError('INVALID_POWER_CONFIG', `Неизвестная настройка ${key}`);
  }
  return { ...base, ...value, ...(value.excluded_user ? { excluded_user: value.excluded_user.trim() } : {}) };
}
export function powerDefaults(env = process.env) {
  const username = os.userInfo().username;
  const bool = (key, fallback) => env[key] === undefined || env[key] === '' ? fallback : env[key] === 'true' ? true : env[key] === 'false' ? false : (() => { throw powerError('INVALID_POWER_CONFIG', `${key}: требуется true/false`); })();
  return validatePowerConfig({
    mode: env.POWER_MODE || 'sleep',
    enabled: bool('POWER_ENABLED', false), background_enabled: bool('POWER_BACKGROUND_ENABLED', false), dry_run: bool('POWER_DRY_RUN', true),
    excluded_user: env.POWER_EXCLUDED_USER || (env.USERDOMAIN ? `${env.USERDOMAIN}\\${username}` : username),
    user_idle_seconds: Number(env.POWER_USER_IDLE_SECONDS || 1800), check_interval_seconds: Number(env.POWER_CHECK_INTERVAL_SECONDS || 60),
    grace_seconds: Number(env.POWER_GRACE_SECONDS || 30), resume_cooldown_seconds: Number(env.POWER_RESUME_COOLDOWN_SECONDS || 300)
  });
}
export function powerWorkBlockers({ jobs = [], running = 0, transfers = 0 } = {}) {
  const entries = [...jobs];
  if (running > 0 || entries.some(job => ['queued', 'running', 'retrying'].includes(job.status))) return ['JOBS_PENDING'];
  if (transfers > 0) return ['ARTIFACT_TRANSFER'];
  if (entries.some(job => ['pending', 'delivering', 'retrying'].includes(job.callback_delivery?.status))) return ['CALLBACK_PENDING'];
  return [];
}
export function assessPowerSnapshot(snapshot, config) {
  if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.sessions) || typeof snapshot.excluded_sid !== 'string' || !snapshot.excluded_sid) return 'SESSION_DATA_UNAVAILABLE';
  for (const session of snapshot.sessions) {
    if (session.account_sid === snapshot.excluded_sid) continue;
    if (!session.account || !['active', 'connected', 'disconnected', 'connect_query', 'shadow', 'idle'].includes(session.state)
      || !Number.isFinite(session.idle_seconds) || session.idle_seconds < 0) return 'SESSION_DATA_UNAVAILABLE';
    if (session.idle_seconds <= config.user_idle_seconds) return 'USER_ACTIVE';
  }
  if (config.mode === 'hibernate') {
    if (snapshot.hibernate_supported !== true) return 'HIBERNATE_UNSUPPORTED';
  } else if (snapshot.suspend_supported !== true) return 'SUSPEND_UNSUPPORTED';
  if (snapshot.suspend_privilege !== true) return 'POWER_PRIVILEGE_MISSING';
  return null;
}
export function createWindowsPowerAdapter({ platform = process.platform, env = process.env, run = executeFile } = {}) {
  const shell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('../windows/power-helper.ps1', import.meta.url));
  const invoke = async (mode, config, signal) => {
    if (platform !== 'win32') throw powerError('POWER_OS_UNSUPPORTED', 'Модуль suspend поддерживает только Windows', 503);
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', mode, '-PowerMode', config.mode || 'sleep',
      '-ExcludedUser', config.excluded_user, '-IdleSeconds', String(config.user_idle_seconds), '-OwnerPid', String(process.pid)];
    const { stdout } = await run(shell, args, { shell: false, windowsHide: true, timeout: mode === 'Inspect' ? 15000 : 0, maxBuffer: 1024 * 1024, signal });
    let response;
    try { response = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim()); } catch { throw powerError('POWER_HELPER_INVALID', 'Неверный ответ Windows-модуля', 503); }
    if (response.error) throw powerError(response.error.code, response.error.message, 503);
    return response;
  };
  return { supported: platform === 'win32', inspect: (config, signal) => invoke('Inspect', config, signal), suspend: (config, signal) => invoke('Suspend', config, signal) };
}

export async function createPowerManager({ dataDir, defaults = powerDefaults(), adapter = createWindowsPowerAdapter(), getBlockers = () => [], beforeSuspend = async () => {}, onRelease = () => {}, logger = console, wait = delay, now = Date.now }) {
  const directory = path.join(dataDir, 'power');
  const configFile = path.join(directory, 'config.json');
  const auditFile = path.join(directory, 'events.jsonl');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let config = defaults, overrides = {};
  try { overrides = JSON.parse(await readFile(configFile, 'utf8')); config = validatePowerConfig(overrides, defaults); }
  catch (error) { if (error.code !== 'ENOENT') throw powerError('POWER_CONFIG_READ_FAILED', 'Не удалось прочитать настройки suspend; исправьте DATA_DIR/power/config.json', 503); }
  let timer, inFlight, controller, closed = false, committing = false, generation = 0, cooldownUntil = 0, updating = 0;
  let last = { state: 'idle', reason: null, checked_at: null };
  let writes = Promise.resolve();
  const record = async (state, reason, source, extra = {}) => {
    last = { state, reason, source, checked_at: new Date(now()).toISOString(), ...extra };
    const event = { ...last };
    writes = writes.catch(() => {}).then(async () => {
      try { if ((await stat(auditFile)).size > 1024 * 1024) await rename(auditFile, auditFile + '.previous'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await appendFile(auditFile, JSON.stringify(event) + '\n', { mode: 0o600 });
    });
    await writes;
  };
  const reschedule = () => {
    clearInterval(timer);
    if (!closed && config.enabled && config.background_enabled && adapter.supported) {
      timer = setInterval(() => { void request('background').catch(error => logger.error('Power background check failed:', error.code)); }, config.check_interval_seconds * 1000); timer.unref();
    }
  };
  const cancel = () => { if (committing) throw powerError('POWER_TRANSITION_IN_PROGRESS', 'Переход в suspend уже начат', 409); generation++; controller?.abort(); };
  const check = async source => {
    const version = generation;
    const settings = { ...config };
    controller = new AbortController();
    const signal = controller.signal;
    let transitionStarted = false;
    const stale = () => closed || version !== generation || signal.aborted || !config.enabled;
    const blocked = async () => {
      if (stale()) { await record('cancelled', 'CHECK_CANCELLED', source); return true; }
      if (updating) { await record('blocked', 'CONFIG_UPDATING', source); return true; }
      const reasons = getBlockers();
      if (reasons.length) { await record('blocked', reasons[0], source); return true; }
      if (now() < cooldownUntil) { await record('blocked', 'RESUME_COOLDOWN', source); return true; }
      return false;
    };
    try {
      if (await blocked()) return;
      let snapshot = await adapter.inspect(settings, signal);
      if (await blocked()) return;
      let reason = assessPowerSnapshot(snapshot, settings);
      if (reason) { await record('blocked', reason, source); return; }
      await record('grace', null, source, { grace_seconds: settings.grace_seconds });
      await wait(settings.grace_seconds * 1000, undefined, { signal });
      if (await blocked()) return;
      snapshot = await adapter.inspect(settings, signal);
      if (await blocked()) return;
      reason = assessPowerSnapshot(snapshot, settings);
      if (reason) { await record('blocked', reason, source); return; }
      // No await between final synchronous admission gate and taking the lock.
      if (stale() || updating || getBlockers().length) { await record('cancelled', 'WORK_CHANGED', source); return; }
      committing = true;
      await beforeSuspend();
      if (await blocked()) return;
      if (settings.dry_run) { await record('dry_run', 'WOULD_SUSPEND', source); return; }
      await record('suspending', null, source, { mode: settings.mode || 'sleep' });
      if (await blocked()) return;
      // Helper repeats the WTS and privilege checks immediately before SetSuspendState.
      transitionStarted = true;
      const result = await adapter.suspend(settings, signal);
      cooldownUntil = now() + settings.resume_cooldown_seconds * 1000;
      await record(result.suspended === true ? 'resumed' : 'blocked', result.reason || null, source);
    } catch (error) {
      if (transitionStarted) cooldownUntil = Math.max(cooldownUntil, now() + settings.resume_cooldown_seconds * 1000);
      try { await record(signal.aborted ? 'cancelled' : 'error', signal.aborted ? 'CHECK_CANCELLED' : error.code || 'POWER_CHECK_FAILED', source); }
      catch { logger.error('Power audit write failed'); }
    } finally { committing = false; controller = null; if (!closed) onRelease(); }
  };
  function request(source = 'api') {
    if (closed || !config.enabled || !adapter.supported) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = check(source).finally(() => { inFlight = null; });
    return inFlight;
  }
  reschedule();
  return {
    get committing() { return committing; },
    get stopping() { return closed; },
    get config() { return { ...config }; },
    status: () => ({ supported: adapter.supported, config: { ...config }, checking: !!inFlight, committing, last: { ...last } }),
    assertAvailable() {
      if (closed || !adapter.supported) throw powerError('POWER_OS_UNSUPPORTED', 'Модуль suspend недоступен на этой ОС', 503);
      if (!config.enabled) throw powerError('POWER_DISABLED', 'Модуль suspend выключен настройкой enabled', 503);
    },
    assertAcceptingWork() { if (closed) throw powerError('POWER_STOPPING', 'Сервис останавливается; повторите запрос позже', 503); if (committing) throw powerError('POWER_TRANSITION_IN_PROGRESS', 'УН готовится к suspend; повторите запрос после пробуждения или выберите другую УН', 503); },
    notifyWork() { if (!committing) { generation++; controller?.abort(); } },
    request,
    async inspect() { return adapter.inspect(config); },
    async update(patch) {
      if (committing) throw powerError('POWER_TRANSITION_IN_PROGRESS', 'Настройки нельзя менять во время перехода в suspend', 409);
      const resetUser = patch && Object.hasOwn(patch, 'excluded_user') && patch.excluded_user === null;
      const validatedPatch = resetUser ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'excluded_user')) : patch;
      validatePowerConfig(validatedPatch, config);
      cancel(); updating++;
      // Serialize writes so simultaneous PATCH calls cannot lose acknowledged changes.
      const operation = writes.catch(() => {}).then(async () => {
        const nextOverrides = { ...overrides, ...validatedPatch };
        if (resetUser) delete nextOverrides.excluded_user;
        const merged = validatePowerConfig(nextOverrides, defaults);
        const temporary = configFile + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, JSON.stringify(nextOverrides, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temporary, configFile);
        } finally { await unlink(temporary).catch(() => {}); }
        generation++; overrides = nextOverrides; config = merged; reschedule();
        return { ...config };
      });
      const completed = operation.finally(() => { updating--; });
      writes = completed.then(() => {}, () => {});
      return completed;
    },
    cancel,
    async close() { closed = true; generation++; clearInterval(timer); controller?.abort(); await inFlight; await writes.catch(() => {}); }
  };
}
