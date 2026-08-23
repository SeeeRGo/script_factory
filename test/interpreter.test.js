import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ERROR_CODES,
  createDefaultStepRegistry,
  executeScript,
  resolveTemplates,
  validateScript
} from '../src/interpreter.js';

test('the default registry contains every Stage 2 action', () => {
  assert.deepEqual(createDefaultStepRegistry().actions(), [
    'noop',
    'wait',
    'check_ip',
    'launch_browser',
    'navigate',
    'auth_ecp',
    'find_files',
    'upload_files',
    'download_files',
    'validate_report',
    'submit_if_valid',
    'move_files',
    'copy_files',
    'read_text_file',
    'write_text_file',
    'open_file',
    'delete_files'
  ]);
});

test('script validation reports contract errors with JSON paths', () => {
  const errors = validateScript({
    steps: [
      { action: 'missing_action' },
      { action: 'navigate', params: [] },
      { action: 'noop', timeout_ms: 0 }
    ],
    default_step_timeout_ms: 0
  });

  assert.deepEqual(errors, [
    { path: 'script.default_step_timeout_ms', message: 'default_step_timeout_ms должен быть положительным целым числом' },
    { path: 'script.steps[0].action', message: 'неподдерживаемое действие: missing_action' },
    { path: 'script.steps[1].params', message: 'params должен быть объектом' },
    { path: 'script.steps[2].timeout_ms', message: 'timeout_ms должен быть положительным целым числом' }
  ]);
});

test('validates native Chrome Recorder flows without registering actions', () => {
  assert.deepEqual(validateScript({
    title: 'Recorder flow',
    timeout: 5000,
    steps: [
      { type: 'navigate', url: 'https://example.test' },
      { type: 'waitForElement', selectors: [['#ready']], visible: true }
    ]
  }), []);

  const invalid = validateScript({ title: 'Broken flow', steps: [{ type: 'click', selectors: [['#button']] }] });
  assert.equal(invalid[0].path, 'script');
  assert.match(invalid[0].message, /offsetX/);

  assert.deepEqual(validateScript({
    title: 'Non-portable flow',
    steps: [{ type: 'customStep', name: 'external-code', parameters: {} }]
  }), [{
    path: 'script.steps[0].type',
    message: 'customStep не является переносимым браузерным действием; используйте стандартный шаг Chrome Recorder'
  }]);
});

test('parameter templates preserve exact values and interpolate nested context', () => {
  const context = {
    root_dir: '/reports/incoming',
    found_files: ['FNS.xml', 'SFR.xml'],
    prefixes: ['FNS', 'SFR'],
    nested: { value: 'ready' }
  };
  const resolved = resolveTemplates({
    directory: '{{root_dir}}',
    files: '{{found_files}}',
    prefixes: '{{prefixes}}',
    label: 'State: {{nested.value}}',
    nested: ['{{root_dir}}']
  }, context);

  assert.equal(resolved.directory, '/reports/incoming');
  assert.deepEqual(resolved.files, ['FNS.xml', 'SFR.xml']);
  assert.deepEqual(resolved.prefixes, ['FNS', 'SFR']);
  assert.equal(resolved.label, 'State: ready');
  assert.deepEqual(resolved.nested, ['/reports/incoming']);
});

test('a complete report workflow passes context between steps and emits lifecycle events', async () => {
  const events = [];
  const result = await executeScript({
    script: {
      steps: [
        { action: 'check_ip', params: { expected_ip: '10.0.0.5', current_ip: '10.0.0.5' }, duration_ms: 1 },
        { action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 1 },
        { action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 1 },
        { action: 'auth_ecp', params: { plugin_running: true }, duration_ms: 1 },
        { action: 'find_files', params: { directory: '{{root_dir}}', files: ['FNS.xml'] }, duration_ms: 1 },
        { action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 1 },
        { action: 'validate_report', params: { valid: true }, duration_ms: 1 },
        { action: 'submit_if_valid', params: {}, duration_ms: 1 },
        {
          id: 'receipt',
          action: 'download_files',
          params: {
            destination: '{{download_dir}}',
            files: [{ filename: 'receipt.pdf', source_url: 'https://example.test/receipt.pdf', size_bytes: 128 }]
          },
          duration_ms: 1
        },
        { action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 1 }
      ]
    },
    initialContext: { root_dir: '/incoming', loaded_dir: '/loaded', download_dir: '/downloads' },
    onEvent: (event) => events.push(event)
  });

  assert.equal(result.steps_executed, 10);
  assert.equal(result.context.browser_launched, true);
  assert.equal(result.context.current_url, 'https://online.sbis.ru');
  assert.equal(result.context.authenticated, true);
  assert.deepEqual(result.context.found_files, ['FNS.xml']);
  assert.deepEqual(result.context.uploaded_files, ['FNS.xml']);
  assert.equal(result.context.report_valid, true);
  assert.equal(result.context.submitted, true);
  assert.deepEqual(result.context.downloaded_files, ['/downloads/receipt.pdf']);
  assert.equal(result.context.artifacts[0].kind, 'downloaded_file');
  assert.equal(result.context.artifacts[0].filename, 'receipt.pdf');
  assert.equal(result.context.artifacts[0].size_bytes, 128);
  assert.equal(result.context.loaded_dir, '/loaded');
  assert.equal(events[0].type, 'script_started');
  assert.equal(events.at(-1).type, 'script_completed');
  assert.equal(events.filter((event) => event.type === 'step_started').length, 10);
  assert.equal(events.filter((event) => event.type === 'step_completed').length, 10);
});

test('file steps find reports by prefix and move them on the real filesystem', async (t) => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'script-factory-files-'));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));
  await mkdir(path.join(workingDirectory, 'incoming'));
  await writeFile(path.join(workingDirectory, 'incoming', 'FNS_report.xml'), '<report />');
  await writeFile(path.join(workingDirectory, 'incoming', 'ignore.txt'), 'ignore');

  const result = await executeScript({
    script: {
      context: {
        root_dir: './incoming',
        loaded_dir: './loaded',
        prefixes: ['FNS']
      },
      steps: [
        {
          action: 'find_files',
          duration_ms: 0,
          params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}' }
        },
        {
          action: 'move_files',
          duration_ms: 0,
          params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }
        }
      ]
    },
    registry: createDefaultStepRegistry({ workingDirectory })
  });

  assert.equal(result.context.found_files.length, 1);
  assert.deepEqual(await readdir(path.join(workingDirectory, 'loaded')), ['FNS_report.xml']);
});

test('wait uses a duration supplied through the script context', async () => {
  const startedAt = Date.now();
  const result = await executeScript({
    script: {
      context: { delay_ms: 25 },
      steps: [{ action: 'wait', params: { duration_ms: '{{delay_ms}}' }, timeout_ms: 200 }]
    }
  });
  assert.equal(result.context.waited_ms, 25);
  assert.ok(Date.now() - startedAt >= 20);
});

test('inter_step_delay_ms pauses only between steps and can be disabled with zero', async () => {
  const events = [];
  const startedAt = Date.now();
  await executeScript({
    script: {
      inter_step_delay_ms: 20,
      steps: [
        { action: 'noop', duration_ms: 0 },
        { action: 'noop', duration_ms: 0 },
        { action: 'noop', duration_ms: 0 }
      ]
    },
    onEvent: (event) => events.push(event)
  });
  assert.ok(Date.now() - startedAt >= 35);
  assert.equal(events.filter((event) => event.type === 'inter_step_delay_started').length, 2);

  const disabledEvents = [];
  await executeScript({
    script: {
      inter_step_delay_ms: 0,
      steps: [{ action: 'noop', duration_ms: 0 }, { action: 'noop', duration_ms: 0 }]
    },
    onEvent: (event) => disabledEvents.push(event)
  });
  assert.equal(disabledEvents.some((event) => event.type === 'inter_step_delay_started'), false);
});

test('controlled file steps copy, read, write and delete only inside allowed roots', async (t) => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'script-factory-controlled-files-'));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));
  await mkdir(path.join(workingDirectory, 'incoming'));
  await writeFile(path.join(workingDirectory, 'incoming', 'TEST_source.txt'), 'source');
  const registry = createDefaultStepRegistry({ workingDirectory, allowedRoots: [workingDirectory] });

  const result = await executeScript({
    registry,
    script: {
      steps: [
        { action: 'copy_files', params: { files: ['./incoming/TEST_source.txt'], destination: './archive' } },
        { action: 'write_text_file', params: { path: './out/result.txt', content: 'готово' } },
        { action: 'read_text_file', params: { path: './out/result.txt' } },
        { action: 'delete_files', params: { files: ['./archive/TEST_source.txt'], confirm: true } }
      ]
    }
  });

  assert.equal(result.context.file_content, 'готово');
  assert.equal(await readFile(path.join(workingDirectory, 'out', 'result.txt'), 'utf8'), 'готово');
  assert.deepEqual(await readdir(path.join(workingDirectory, 'archive')), []);

  await assert.rejects(
    executeScript({
      registry,
      script: { steps: [{ action: 'read_text_file', params: { path: path.resolve(workingDirectory, '..', 'outside.txt') } }] }
    }),
    (error) => error.code === 'FILESYSTEM_ACCESS_DENIED'
  );
});

test('downloads a real response, saves it and opens the local copy', async (t) => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'script-factory-download-'));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));
  const artifactDirectory = path.join(workingDirectory, 'artifacts');
  const document = '<!doctype html><title>Скачанный документ</title><h1>Готово</h1>';
  let openedFile;
  const registry = createDefaultStepRegistry({
    workingDirectory,
    allowedRoots: [workingDirectory],
    artifactDirectory,
    publicArtifactBasePath: '/artifacts/job-test',
    downloadBaseUrl: 'http://127.0.0.1:3000',
    fetchImpl: async (url) => {
      assert.equal(url.href, 'http://127.0.0.1:3000/demo/file.html');
      return new Response(document, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
    openFile: async ({ file }) => {
      openedFile = file;
      return {
        opened_url: `file://${file}`,
        page_title: 'Скачанный документ',
        artifact: {
          artifact_id: 'job-test_opened-file',
          kind: 'browser_screenshot',
          filename: 'opened-file.png',
          local_path: path.join(artifactDirectory, 'opened-file.png'),
          public_url: '/artifacts/job-test/opened-file.png',
          mime_type: 'image/png',
          size_bytes: 1024,
          created_at: new Date().toISOString()
        }
      };
    }
  });

  const result = await executeScript({
    registry,
    script: {
      steps: [
        {
          id: 'download',
          action: 'download_files',
          params: {
            save: true,
            files: [{ filename: 'document.html', source_url: '/demo/file.html' }]
          }
        },
        { action: 'read_text_file', params: { path: '{{downloaded_files.0}}' } },
        { action: 'open_file', params: { path: '{{downloaded_files.0}}' } }
      ]
    }
  });

  const savedFile = path.join(artifactDirectory, 'document.html');
  assert.equal(openedFile, savedFile);
  assert.equal(await readFile(savedFile, 'utf8'), document);
  assert.equal(result.context.opened_file, savedFile);
  assert.equal(result.context.page_title, 'Скачанный документ');
  assert.equal(result.context.artifacts.length, 2);
  assert.equal(result.context.artifacts[0].public_url, '/artifacts/job-test/document.html');
  assert.match(result.context.artifacts[0].checksum_sha256, /^[a-f0-9]{64}$/);
});

test('check_ip obtains and validates the public IP through its internet provider', async () => {
  const registry = createDefaultStepRegistry({
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://api64.ipify.org/?format=json');
      return new Response('{"ip":"203.0.113.42"}', {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const result = await executeScript({
    registry,
    script: {
      steps: [{ action: 'check_ip', params: { service_url: 'https://api64.ipify.org/?format=json' } }]
    }
  });
  assert.equal(result.context.current_ip, '203.0.113.42');
  assert.equal(result.context.ip_checked_online, true);
  assert.equal(result.context.ip_service_url, 'https://api64.ipify.org/?format=json');
});

for (const scenario of [
  ['check_ip', { expected_ip: '1.1.1.1', current_ip: '2.2.2.2' }, ERROR_CODES.IP_MISMATCH],
  ['find_files', { files: [] }, ERROR_CODES.FILE_NOT_FOUND],
  ['auth_ecp', { authenticated: false }, ERROR_CODES.AUTH_ERROR],
  ['auth_ecp', { plugin_running: false }, ERROR_CODES.PLUGIN_NOT_RUNNING],
  ['upload_files', { files: ['a.xml'], upload_failed: true }, ERROR_CODES.UPLOAD_ERROR],
  ['download_files', { files: ['receipt.pdf'], download_failed: true }, ERROR_CODES.DOWNLOAD_ERROR],
  ['validate_report', { valid: false }, ERROR_CODES.VALIDATION_ERROR]
]) {
  const [action, params, expectedCode] = scenario;
  test(`${action} normalizes failures as ${expectedCode}`, async () => {
    await assert.rejects(
      executeScript({ script: { steps: [{ action, params, duration_ms: 0 }] } }),
      (error) => error.code === expectedCode && typeof error.retryable === 'boolean'
    );
  });
}

test('per-step timeout aborts the handler with TIMEOUT_ERROR', async () => {
  await assert.rejects(
    executeScript({
      script: { steps: [{ action: 'noop', duration_ms: 50, timeout_ms: 5 }] }
    }),
    (error) => error.code === ERROR_CODES.TIMEOUT_ERROR && error.retryable === true
  );
});
