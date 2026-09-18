import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
export const IP_MONITOR_SETTINGS_PATH = 'C:\\_external ip monitor\\settings.ini';
export const IP_CHECK_URL = 'https://api.ipify.org?format=json';
export const IP_CHECK_TIMEOUT_MS = 3000;
const VERSION_TIMEOUT_MS = 2500;

function checkError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 503 });
}

function normalizedIp(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  const family = isIP(address);
  if (!family || address.includes('%')) return null;
  return family === 6 ? new URL(`http://[${address}]/`).hostname : address;
}

export function parseMonitorSettings(source) {
  let section = '';
  const addresses = [];
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const header = line.match(/^\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const entry = line.match(/^ip_adress\s*=\s*(.*?)\s*(?:[;#].*)?$/i);
    if (section === 'main' && entry) addresses.push(normalizedIp(entry[1]));
  }
  if (addresses.length !== 1 || !addresses[0]) {
    throw checkError('IP_SETTINGS_INVALID', 'В settings.ini требуется один корректный [main] ip_adress');
  }
  return addresses[0];
}

export async function checkExternalIp({
  settingsPath = process.env.IP_MONITOR_SETTINGS_PATH || IP_MONITOR_SETTINGS_PATH,
  url = process.env.IP_CHECK_URL || IP_CHECK_URL,
  timeoutMs = IP_CHECK_TIMEOUT_MS
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(IP_CHECK_TIMEOUT_MS, Math.max(1, timeoutMs)));
  try {
    let source;
    try {
      source = await readFile(settingsPath, { encoding: 'utf8', signal: controller.signal });
    } catch {
      throw checkError('IP_SETTINGS_READ_FAILED', 'Не удалось прочитать настройки IP-монитора');
    }
    const expected = parseMonitorSettings(source);
    let actual;
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw checkError('IP_LOOKUP_FAILED', 'Сервис определения внешнего IP недоступен');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1024) throw checkError('IP_LOOKUP_INVALID', 'Сервис определения внешнего IP вернул некорректный ответ');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      let value = text;
      if (text.startsWith('{')) {
        try {
          value = JSON.parse(text).ip;
        } catch {
          value = null;
        }
      }
      actual = normalizedIp(value);
      if (!actual) throw checkError('IP_LOOKUP_INVALID', 'Сервис определения внешнего IP вернул некорректный ответ');
    } catch (error) {
      if (error?.statusCode === 503) throw error;
      throw checkError('IP_LOOKUP_FAILED', 'Сервис определения внешнего IP недоступен');
    }
    if (actual !== expected) throw checkError('IP_MISMATCH', 'Внешний IP не совпадает с настройками IP-монитора');
    return { status: 'success' };
  } catch (error) {
    if (controller.signal.aborted) throw checkError('IP_CHECK_TIMEOUT', 'Превышено время ожидания проверки IP');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function prefixResourceFields(value, prefix = '') {
  if (Array.isArray(value)) return value.map((item) => prefixResourceFields(item, prefix));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = prefix ? `${prefix}_${key}` : key;
    return [name, prefixResourceFields(item, name)];
  }));
}

export async function detectYandexVersion({
  platform = process.platform,
  env = process.env,
  run = executeFile
} = {}) {
  const probes = [];
  if (platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      probes.push({
        file: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
        args: ['query', `${hive}\\Software\\Yandex\\YandexBrowser\\BLBeacon`, '/v', 'version'],
        pattern: /\bversion\s+REG_SZ\s+(\d+(?:\.\d+){2,3})\b/i
      });
    }
  } else if (platform === 'linux') {
    for (const file of [...new Set([
      env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/yandex-browser-stable',
      '/usr/bin/yandex-browser',
      '/opt/yandex/browser/yandex-browser'
    ].filter(Boolean))]) {
      probes.push({ file, args: ['--version'], pattern: /\bYandex(?:\s+Browser)?\s+(\d+(?:\.\d+){2,3})\b/i });
    }
  } else if (platform === 'darwin') {
    probes.push({
      file: '/usr/libexec/PlistBuddy',
      args: ['-c', 'Print :CFBundleShortVersionString', '/Applications/Yandex.app/Contents/Info.plist'],
      pattern: /^\s*(\d+(?:\.\d+){2,3})\s*$/
    });
  }
  const deadline = Date.now() + VERSION_TIMEOUT_MS;
  for (const probe of probes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const { stdout } = await run(probe.file, probe.args, {
        timeout: Math.min(1000, remaining),
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        windowsHide: true,
        shell: false
      });
      const version = String(stdout).match(probe.pattern)?.[1];
      if (version) return version;
    } catch {}
  }
  return null;
}
