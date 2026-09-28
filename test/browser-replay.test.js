import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isYandexCaptchaUrl, resolveBrowserUploadFiles, waitForYandexCaptcha } from '../src/browser-replay.js';

const captchaUrl = 'https://ya.ru/showcaptcha?cc=1&retpath=search';

test('browser uploads reject paths outside allowed roots, directories and escaping symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const report = path.join(allowed, 'report.xml');
  const outside = path.join(root, 'outside.xml');
  await writeFile(report, '<report/>');
  await writeFile(outside, 'private');
  assert.equal((await resolveBrowserUploadFiles([report], [allowed]))[0].size_bytes, 9);
  await assert.rejects(resolveBrowserUploadFiles([outside], [allowed]), { code: 'FILESYSTEM_ACCESS_DENIED' });
  await assert.rejects(resolveBrowserUploadFiles([report], []), { code: 'FILESYSTEM_ACCESS_DENIED' });
  await assert.rejects(resolveBrowserUploadFiles([allowed], [allowed]), { code: 'INVALID_UPLOAD_FILES' });
  await assert.rejects(resolveBrowserUploadFiles([path.join(allowed, 'missing.xml')], [allowed]), { code: 'FILE_NOT_FOUND' });
  await assert.rejects(resolveBrowserUploadFiles([], [allowed]), { code: 'INVALID_UPLOAD_FILES' });
  const link = path.join(allowed, 'link.xml');
  try {
    await symlink(outside, link);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(resolveBrowserUploadFiles([link], [allowed]), { code: 'FILESYSTEM_ACCESS_DENIED' });
});

test('recognizes Yandex SmartCaptcha URLs without matching normal search pages', () => {
  assert.equal(isYandexCaptchaUrl(captchaUrl), true);
  assert.equal(isYandexCaptchaUrl('https://yandex.ru/showcaptcha/check'), true);
  assert.equal(isYandexCaptchaUrl('https://ya.ru/search?text=node'), false);
  assert.equal(isYandexCaptchaUrl('https://example.org/showcaptcha'), false);
});

test('returns CAPTCHA_REQUIRED immediately when manual confirmation is unavailable', async () => {
  await assert.rejects(
    waitForYandexCaptcha({ page: { url: () => captchaUrl }, headless: true, waitMs: 120000 }),
    (error) => error.code === 'CAPTCHA_REQUIRED'
      && error.details.manual_confirmation_available === false
  );
});

test('continues after CAPTCHA is manually confirmed in headed mode', async () => {
  let checks = 0;
  const logs = [];
  const page = {
    url() {
      checks += 1;
      return checks < 3 ? captchaUrl : 'https://ya.ru/search?text=node';
    }
  };
  const handled = await waitForYandexCaptcha({
    page,
    headless: false,
    waitMs: 100,
    pollIntervalMs: 1,
    onBrowserLog: (level, message) => logs.push({ level, message })
  });
  assert.equal(handled, true);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs.at(-1).level, 'info');
});

test('returns CAPTCHA_REQUIRED instead of a generic step timeout when confirmation expires', async () => {
  await assert.rejects(
    waitForYandexCaptcha({
      page: { url: () => captchaUrl },
      headless: false,
      waitMs: 5,
      pollIntervalMs: 1
    }),
    (error) => error.code === 'CAPTCHA_REQUIRED'
      && error.details.manual_confirmation_available === true
      && error.details.wait_ms === 5
  );
});
