import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkExternalIp,
  detectYandexVersion,
  IP_MONITOR_SETTINGS_PATH,
  parseMonitorSettings,
  prefixResourceFields
} from '../src/system-checks.js';

const expectedIp = '203.0.113.10';
const otherIp = '203.0.113.11';

function assertCheckError(error, code) {
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(!error.message.includes(expectedIp));
  assert.ok(!error.message.includes(otherIp));
  return true;
}

test('parses only main ip_adress with whitespace, BOM and comments', () => {
  assert.equal(IP_MONITOR_SETTINGS_PATH, 'C:\\_external ip monitor\\settings.ini');
  assert.equal(parseMonitorSettings(`\uFEFF[main]\r\n; note\r\nip_adress = ${expectedIp} ; note\r\n[log]\r\nip_adress = invalid`), expectedIp);
  assert.equal(parseMonitorSettings('[main]\nip_adress=2001:0db8:0:0::1'), '[2001:db8::1]');
  for (const source of [
    '[log]\nip_adress=203.0.113.10',
    '[main]\nip_address=203.0.113.10',
    '[main]\nip_adress=invalid',
    '[main]\nip_adress=',
    '[main]\nip_adress=203.0.113.10\nip_adress=203.0.113.10',
    '[main]\nip_adress=fe80::1%eth0'
  ]) {
    assert.throws(() => parseMonitorSettings(source), (error) => assertCheckError(error, 'IP_SETTINGS_INVALID'));
  }
});

test('prefixes all nested resource keys without altering top-level fields or values', () => {
  assert.deepEqual(prefixResourceFields({
    api_version: 'v2', cpu: { load_average: [1, 2, 3] }, disk: null,
    memory_usage: { rss: 7, heapUsed: 3 }, browser_replay: { live_view: { enabled: false } }
  }), {
    api_version: 'v2', cpu: { cpu_load_average: [1, 2, 3] }, disk: null,
    memory_usage: { memory_usage_rss: 7, memory_usage_heapUsed: 3 },
    browser_replay: { browser_replay_live_view: { browser_replay_live_view_enabled: false } }
  });
});

test('detects Yandex identity, not Chromium or environment product labels', async () => {
  const calls = [];
  const version = await detectYandexVersion({
    platform: 'linux', env: { PUPPETEER_EXECUTABLE_PATH: '/custom/chromium', BROWSER_PRODUCT: 'yandex' },
    run: async (file, args, options) => {
      calls.push(file);
      assert.deepEqual(args, ['--version']);
      assert.equal(options.shell, false);
      assert.ok(options.timeout <= 1000);
      assert.equal(options.maxBuffer, 16 * 1024);
      return { stdout: file === '/custom/chromium' ? 'Chromium 140.0.0.0' : 'Yandex Browser 25.8.1.100' };
    }
  });
  assert.equal(version, '25.8.1.100');
  assert.equal(calls.length, 2);
  assert.equal(await detectYandexVersion({
    platform: 'linux', env: {}, run: async () => ({ stdout: 'Chromium 140.0.0.0' })
  }), null);
  assert.equal(await detectYandexVersion({
    platform: 'linux', env: {}, run: async () => { throw new Error('missing'); }
  }), null);
  assert.equal(await detectYandexVersion({ platform: 'freebsd', env: {} }), null);
});

test('uses bounded Windows registry and macOS metadata probes without launching browsers', async () => {
  assert.equal(await detectYandexVersion({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    run: async (file, args, options) => {
      assert.equal(file, 'C:\\Windows\\System32\\reg.exe');
      assert.equal(args[0], 'query');
      assert.match(args[1], /YandexBrowser\\BLBeacon$/);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return { stdout: '    version    REG_SZ    25.8.1.100\r\n' };
    }
  }), '25.8.1.100');
  assert.equal(await detectYandexVersion({
    platform: 'darwin', env: {}, run: async (file, args) => {
      assert.equal(file, '/usr/libexec/PlistBuddy');
      assert.equal(args.at(-1), '/Applications/Yandex.app/Contents/Info.plist');
      return { stdout: '25.8.1.100\n' };
    }
  }), '25.8.1.100');
});

test('IP helpers and authenticated endpoints use fresh settings and never expose addresses', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'system-checks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, 'settings.ini');
  await writeFile(settingsPath, `[main]\nip_adress=${expectedIp}`);
  let mode = 'success';
  let calls = 0;
  const lookup = http.createServer((req, res) => {
    calls += 1;
    if (mode === 'timeout') return;
    if (mode === 'body-timeout') {
      res.writeHead(200);
      res.write('{"ip":');
      return;
    }
    res.writeHead(mode === 'failure' ? 500 : 200);
    res.end(mode === 'invalid' ? 'invalid' : mode === 'oversize' ? 'x'.repeat(2000)
      : JSON.stringify({ ip: mode === 'mismatch' ? otherIp : expectedIp }));
  });
  await new Promise((resolve) => lookup.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    lookup.closeAllConnections();
    lookup.close();
  });
  const url = `http://127.0.0.1:${lookup.address().port}`;
  assert.deepEqual(await checkExternalIp({ settingsPath, url }), { status: 'success' });
  for (const [lookupMode, code] of [
    ['mismatch', 'IP_MISMATCH'], ['invalid', 'IP_LOOKUP_INVALID'], ['oversize', 'IP_LOOKUP_INVALID'],
    ['failure', 'IP_LOOKUP_FAILED'], ['timeout', 'IP_CHECK_TIMEOUT'], ['body-timeout', 'IP_CHECK_TIMEOUT']
  ]) {
    mode = lookupMode;
    await assert.rejects(checkExternalIp({ settingsPath, url, timeoutMs: 100 }), (error) => assertCheckError(error, code));
  }
  mode = 'success';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, PORT: String(41000 + Math.floor(Math.random() * 10000)), HOST: '127.0.0.1', API_KEY: 'system-check-key',
      WEB_LOGIN: 'system-check-user', WEB_PASSWORD: 'system-check-password', UN_ID: 'system-check-un',
      DATA_DIR: path.join(directory, 'data'), IP_MONITOR_SETTINGS_PATH: settingsPath, IP_CHECK_URL: url
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 8000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${output}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
  });
  const headers = { 'X-API-Key': 'system-check-key' };
  const check = async (status, code) => {
    const response = await fetch(`${origin}/api/v2/system/ip-check`, { headers });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    if (!code) assert.deepEqual(body, { status: 'success' });
    else {
      assert.deepEqual(Object.keys(body), ['error']);
      assert.deepEqual(Object.keys(body.error), ['code', 'message']);
      assert.equal(body.error.code, code);
    }
    assert.ok(!JSON.stringify(body).includes(expectedIp));
    assert.ok(!JSON.stringify(body).includes(otherIp));
  };
  const beforeUnauthorized = calls;
  for (const resource of ['ip-check', 'resources']) {
    assert.equal((await fetch(`${origin}/api/v2/system/${resource}`)).status, 401);
  }
  assert.equal(calls, beforeUnauthorized);
  await check(200);
  await writeFile(settingsPath, `[main]\nip_adress=${otherIp}`);
  await check(503, 'IP_MISMATCH');
  await writeFile(settingsPath, '[main]\nip_adress=invalid');
  await check(503, 'IP_SETTINGS_INVALID');
  await rm(settingsPath);
  await check(503, 'IP_SETTINGS_READ_FAILED');
  const beforeHealth = calls;
  for (const route of ['/health', '/api/v2/health']) {
    const health = await fetch(`${origin}${route}`).then((response) => response.json());
    assert.ok(!Object.keys(health.checks).some((key) => key.includes('ip')));
    assert.ok(!health.error?.code.startsWith('IP_'));
  }
  assert.equal(calls, beforeHealth);
  await writeFile(settingsPath, `[main]\nip_adress=${expectedIp}`);
  for (const [lookupMode, code] of [['invalid', 'IP_LOOKUP_INVALID'], ['failure', 'IP_LOOKUP_FAILED'], ['timeout', 'IP_CHECK_TIMEOUT']]) {
    mode = lookupMode;
    await check(503, code);
  }
  const response = await fetch(`${origin}/api/v2/system/resources`, { headers });
  assert.equal(response.status, 200);
  const resources = await response.json();
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(resources.api_version, 'v2');
  assert.equal(resources.service_version, metadata.version);
  assert.equal(resources.release_date, metadata.releaseDate);
  assert.equal(resources.un_id, 'system-check-un');
  assert.ok(resources.yandex_browser_version === null || /^\d+(?:\.\d+){2,3}$/.test(resources.yandex_browser_version));
  assert.ok(resources.cpu.cpu_logical_cores > 0);
  assert.ok(resources.memory.memory_total_bytes > 0);
  assert.deepEqual(resources.queue, {
    queue_status: 'idle', queue_queued: 0, queue_running: 0, queue_max_parallel_jobs: 1, queue_available_slots: 1
  });
  const leaves = [];
  for (const [key, value] of Object.entries(resources)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of Object.keys(value)) {
        assert.ok(nested.startsWith(`${key}_`), nested);
        leaves.push(nested);
      }
    } else leaves.push(key);
  }
  assert.equal(leaves.length, new Set(leaves).size);
});
