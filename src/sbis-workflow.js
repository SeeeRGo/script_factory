import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { createRunner, parse, PuppeteerRunnerExtension } from '@puppeteer/replay';
import { StepRegistry, executeScript, InterpreterError, resolveTemplates, abortableDelay } from './interpreter.js';
import { resolveBrowserExecutablePath } from './browser-replay.js';
import { containsInn, selectSbisCertificate, verifySelectedFile } from './sbis-identity.js';
import { validateSbisScript } from './sbis-schema.js';
import { checkExternalIp } from './system-checks.js';

const fail = (code, message, details) => { throw new InterpreterError(code, message, { details }); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (file, root) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

export async function checkedPath(value, roots, { directory = false } = {}) {
  if (typeof value !== 'string' || !value) fail('MISSING_PARAMETER', 'Не задан путь к файлу или каталогу');
  const resolved = await realpath(path.resolve(value));
  const realRoots = await Promise.all(roots.map((root) => realpath(root)));
  if (!realRoots.some((root) => inside(resolved, root))) fail('FILESYSTEM_ACCESS_DENIED', 'Путь вне разрешённых каталогов', { path: value });
  const info = await stat(resolved);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('INVALID_PATH', 'Неверный тип объекта файловой системы');
  return resolved;
}

export async function findLatestReports({ root_dir, prefixes, allow_multiple = true }, roots) {
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some((p) => typeof p !== 'string' || !p.trim())) {
    fail('MISSING_PARAMETER', 'prefixes должен содержать непустые префиксы имён XML');
  }
  const dir = await checkedPath(root_dir, roots, { directory: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const selected = new Map();
  for (const prefix of prefixes) {
    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml') || !entry.name.startsWith(prefix)) continue;
      const file = await checkedPath(path.join(dir, entry.name), roots);
      const info = await stat(file);
      matches.push({ path: file, filename: entry.name, size_bytes: info.size, modified_ms: info.mtimeMs });
    }
    matches.sort((a, b) => b.modified_ms - a.modified_ms || a.filename.localeCompare(b.filename));
    if (!matches.length) fail('FILE_NOT_FOUND', `Не найден XML для префикса ${prefix}`);
    selected.set(matches[0].path, matches[0]);
  }
  const files = [...selected.values()];
  if (!allow_multiple && files.length > 1) fail('MULTIPLE_FILES', 'Найдено несколько файлов, но allow_multiple=false');
  for (const file of files) file.sha256 = hash(await readFile(file.path));
  return files;
}

// Never overwrite an existing archive entry. Keep the original if it changed after upload.
export async function archiveReport(file, destination, roots) {
  const source = await checkedPath(file.path, roots);
  const dir = await checkedPath(destination, roots, { directory: true });
  const target = path.join(dir, path.basename(file.path));
  if (source === target) fail('ARCHIVE_CONFLICT', 'Исходный файл уже находится в целевом каталоге');
  if (hash(await readFile(source)) !== file.sha256) fail('SOURCE_CHANGED', 'Файл изменён после выбора; перемещение запрещено');
  await copyFile(source, target, constants.COPYFILE_EXCL);
  if (hash(await readFile(target)) !== file.sha256 || hash(await readFile(source)) !== file.sha256) {
    fail('SOURCE_CHANGED', 'Контрольная сумма изменилась при архивировании; оригинал сохранён');
  }
  await unlink(source);
  return target;
}

// The twelve public stages are a template: stages 6–11 run once per authority.
export function sbisAuthorityPlans(config) {
  const plans = config.authority_prefixes == null
    ? [{ authority: config.authority, prefixes: config.prefixes }]
    : config.authority_prefixes;
  if (!Array.isArray(plans) || !plans.length || plans.length > 3) {
    fail('MISSING_PARAMETER', 'authority_prefixes: от одного до трёх ведомств');
  }
  const seen = new Set();
  for (const plan of plans) {
    if (!plan || !['FNS', 'SFR', 'ROSSTAT'].includes(plan.authority) || seen.has(plan.authority)) {
      fail('MISSING_PARAMETER', 'Неизвестное или повторное ведомство в authority_prefixes');
    }
    if (!Array.isArray(plan.prefixes) || !plan.prefixes.length || plan.prefixes.some((p) => typeof p !== 'string' || !p.trim())) {
      fail('MISSING_PARAMETER', `Не заданы префиксы XML для ${plan.authority}`);
    }
    seen.add(plan.authority);
  }
  return plans;
}

export async function executeSbisWorkflow(options) {
  const { script, signal, onEvent = () => {}, allowedRoots = [], artifactDirectory, publicArtifactBasePath, jobId } = options;
  const schemaErrors = validateSbisScript(script);
  if (schemaErrors.length) fail('INVALID_SCRIPT', 'Некорректный шаблон СБИС', { errors: schemaErrors });
  const baseConfig = { ...(script.context || {}), ...(options.context || {}) };
  const plans = sbisAuthorityPlans(baseConfig);
  let config = { ...baseConfig, authority: plans[0].authority, prefixes: plans[0].prefixes };
  if (!['preflight', 'validate_only', 'send'].includes(config.mode)) fail('MISSING_PARAMETER', 'mode: preflight, validate_only или send');
  if (!/^\d{10}(\d{2})?$/.test(config.inn || '')) fail('MISSING_PARAMETER', 'Требуется ИНН организации');
  if (config.certificate_inn != null && !/^\d{10}(\d{2})?$/.test(config.certificate_inn)) fail('MISSING_PARAMETER', 'Некорректный certificate_inn');
  if (!['FNS', 'SFR', 'ROSSTAT'].includes(config.authority)) fail('MISSING_PARAMETER', 'Неизвестное ведомство');
  const probe = config.mode === 'preflight';
  let ui = config.ui || {};
  for (const plan of plans) {
    const binding = { ...(baseConfig.ui || {}), ...(plan.ui || {}) };
    if (probe) continue;
    const ui = binding;
    const required = ['organization_selector', 'report_scope_selector', 'validation_status_selector', 'protocol_selector', 'validation_success_text', 'validation_failure_text'];
    if (config.mode === 'send' && config.submit_enabled === true) required.push('sent_status_selector');
    if (ui.report_identity_mode === 'selected_file_and_key') required.push('report_key_expression');
    else if (ui.report_identity_mode && ui.report_identity_mode !== 'filename') fail('MISSING_PARAMETER', 'Неизвестный report_identity_mode');
    const missing = required.filter((key) => !ui[key]);
    for (const key of ['upload_steps', 'validate_steps', ...(config.mode === 'send' && config.submit_enabled === true ? ['reopen_steps', 'submit_steps'] : [])]) {
      if (!Array.isArray(ui[key]) || !ui[key].length) missing.push(key);
    }
    if (!ui.authority_paths?.[plan.authority]) missing.push('authority_paths.' + plan.authority);
    if (missing.length) fail('UI_BINDING_REQUIRED', 'Не настроены обязательные привязки интерфейса настоящего отчёта', { authority: plan.authority, missing });
  }
  let browser;
  let page;
  let activeSignal = signal;
  const allReports = [];
  let reports = [];
  let filesPrepared = false;
  const authorityStates = new Map(plans.map((p) => [p.authority, 'pending']));
  const phases = [];
  let organizationVerified = false;
  let submissionStarted = false;
  const artifacts = [];
  const phase = (name, status, details = {}) => { phases.push({ name, status, ...(['select_authority', 'find_files', 'upload_files', 'validate_report', 'conditional_submit', 'move_files'].includes(name) ? { authority: config.authority } : {}), ...details }); return details; };
  const requireValue = (value, name) => { if (!value) fail('UI_BINDING_REQUIRED', `Не настроен ${name}; требуется запись интерфейса настоящего отчёта`); return value; };
  const abort = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const guard = () => { if (activeSignal?.aborted) throw activeSignal.reason; };
  const artifact = async (filename, contents, mime = 'application/json') => {
    await mkdir(artifactDirectory, { recursive: true });
    const file = path.join(artifactDirectory, filename);
    await writeFile(file, contents);
    const descriptor = { artifact_id: `${jobId}_${filename}`, kind: 'sbis_protocol', filename, local_path: file,
      public_url: `${publicArtifactBasePath}/${encodeURIComponent(filename)}`, mime_type: mime,
      size_bytes: (await stat(file)).size, checksum_sha256: hash(await readFile(file)), created_at: new Date().toISOString() };
    artifacts.push(descriptor);
    return descriptor;
  };
  const snapshot = async (name) => {
    if (!page || page.isClosed()) return;
    try { await artifact(`${name}.png`, await page.screenshot({ fullPage: true }), 'image/png'); } catch { /* Keep original failure. */ }
  };
  const dismissHints = async () => {
    for (const hint of ui.dismissible_popups || []) {
      const scopes = await page.$$(hint.scope_selector);
      try {
        for (const scope of scopes) {
          const matches = await scope.evaluate((e, text) => e.getClientRects().length > 0
            && e.innerText.replace(/\s+/g, ' ').includes(text), hint.text);
          if (!matches) continue;
          const close = await scope.$(hint.close_selector);
          if (!close) fail('UI_BINDING_REQUIRED', 'Не найдена кнопка закрытия настроенной подсказки');
          try { await close.click(); } finally { await close.dispose(); }
          await page.waitForFunction((selector, text) => ![...document.querySelectorAll(selector)].some(e =>
            e.getClientRects().length > 0 && e.innerText.replace(/\s+/g, ' ').includes(text)),
          { timeout: 5000, signal: activeSignal }, hint.scope_selector, hint.text);
          phase('dismiss_popup', 'verified', { title: hint.text });
        }
      } finally { await Promise.all(scopes.map(scope => scope.dispose())); }
    }
  };
  class SbisRunnerExtension extends PuppeteerRunnerExtension {
    async beforeEachStep(step, recording) {
      await super.beforeEachStep(step, recording);
      guard();
      await dismissHints();
      if (step.type === 'doubleClick' && this.reportContext?.file_name
        && step.selectors?.some(chain => chain.some(selector => selector.includes('data-minicard-name')))) {
        this.fileProof = await verifySelectedFile(page, { filename: this.reportContext.file_name, filePath: this.reportContext.file_path });
      }
    }
  }
  const flow = async (steps, context = {}) => {
    guard();
    const recording = parse(resolveTemplates({ title: 'SBIS phase', timeout: 30000, steps }, { ...config, ...context }));
    const extension = new SbisRunnerExtension(browser, page, { timeout: 30000 });
    extension.reportContext = context;
    const runner = await createRunner(recording, extension);
    const cancel = () => { runner.abort(); abort(); };
    activeSignal?.addEventListener('abort', cancel, { once: true });
    try { if (!await runner.run()) fail('CANCELLED', 'Браузерный этап отменён'); guard(); return extension.fileProof; }
    finally { activeSignal?.removeEventListener('abort', cancel); }
  };
  const clickText = (text) => ({ type: 'click', selectors: [[`text/${text}`]], offsetX: 10, offsetY: 10 });
  const visibleText = async (selector) => {
    const node = await page.waitForSelector(requireValue(selector, 'CSS-селектор результата'), { visible: true, timeout: 30000, signal: activeSignal });
    try { return await node.evaluate((e) => e.innerText); } finally { await node.dispose(); }
  };
  const reportContext = (r) => ({ file_name: r.filename, file_path: r.path });
  const reportSelector = (r) => resolveTemplates(requireValue(ui.report_scope_selector, 'ui.report_scope_selector'), { ...config, ...reportContext(r) });
  const visibleCards = async (selector) => page.$$eval(selector, nodes => nodes.filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').length);
  const requireReportIdentity = async (r, { capture = false } = {}) => {
    const selector = reportSelector(r);
    await page.waitForFunction((selector, duplicate) => {
      const cards = [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      return cards.length > 0 || (duplicate && document.body.innerText.includes(duplicate));
    }, { timeout: 30000, signal: activeSignal }, selector, ui.upload_duplicate_text || null);
    if (ui.upload_duplicate_text && await page.evaluate(text => document.body.innerText.includes(text), ui.upload_duplicate_text)) {
      fail('REPORT_ALREADY_IMPORTED', 'СБИС сообщает, что отчёт с такими файлами уже загружен; автоматический повтор импорта запрещён');
    }
    if (await visibleCards(selector) !== 1) fail('REPORT_IDENTITY_MISMATCH', 'Не найдена единственная открытая карточка отчёта');
    if (ui.report_identity_steps?.length) await flow(ui.report_identity_steps, reportContext(r));
    await page.waitForFunction((selector, inn) => {
      const root = [...document.querySelectorAll(selector)].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      return root && new RegExp('(^|[^0-9])' + inn + '([^0-9]|$)').test(root.innerText);
    }, { timeout: 30000, signal: activeSignal }, selector, config.inn).catch(error => {
      if (activeSignal?.aborted) throw error;
      fail('REPORT_IDENTITY_MISMATCH', 'Карточка не подтверждает полный ИНН организации');
    });
    const text = await visibleText(selector);
    if (!containsInn(text, config.inn)) fail('REPORT_IDENTITY_MISMATCH', 'Карточка не подтверждает полный ИНН организации');
    if (ui.report_identity_mode === 'selected_file_and_key') {
      if (!r.file_selection_verified) fail('REPORT_IDENTITY_MISMATCH', 'Не подтверждён исходный XML по имени и полному пути');
      const key = await page.evaluate(resolveTemplates(requireValue(ui.report_key_expression, 'ui.report_key_expression'), { ...config, ...reportContext(r) }));
      if (typeof key !== 'string' || !key.trim() || key.length > 256) fail('REPORT_IDENTITY_MISMATCH', 'Не подтверждён идентификатор карточки');
      if (capture && !r.report_key) r.report_key = key;
      else if (r.report_key !== key) fail('REPORT_IDENTITY_MISMATCH', 'Открыта другая карточка отчёта');
    } else if (!text.includes(r.filename)) {
      fail('REPORT_IDENTITY_MISMATCH', 'Карточка не подтверждает имя текущего XML');
    }
    return selector;
  };
  const registry = new StepRegistry();
  const register = (name, fn) => registry.register(name, async (input) => {
    activeSignal = input.signal;
    const cancel = () => abort();
    activeSignal?.addEventListener('abort', cancel, { once: true });
    try { guard(); const output = await fn(input); guard(); return output; }
    finally { activeSignal?.removeEventListener('abort', cancel); }
  });
  register('check_ip', async () => {
    await (options.checkIp || checkExternalIp)();
    return phase('check_ip', 'verified', { ip_matches_expected: true });
  });
  register('launch_browser', async () => {
    const executablePath = await resolveBrowserExecutablePath(options.executablePath);
    const headless = options.headless ?? true;
    browser = await puppeteer.launch({ executablePath, headless,
      defaultViewport: headless ? { width: 1400, height: 860 } : null,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1400,860'] });
    page = (await browser.pages())[0] || await browser.newPage();
    await page.bringToFront();
    await page.evaluateOnNewDocument(() => { try { Object.defineProperty(Navigator.prototype, 'registerProtocolHandler', { configurable: true, value: () => {} }); } catch {} });
    page.on('pageerror', () => {}); // Non-Error site exceptions must not crash the worker.
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return phase('launch_browser', 'verified', { browser_launched: true, viewport_width: viewport.width, viewport_height: viewport.height });
  });
  const goTo = async (url) => {
    // Retry navigation only; never repeat a submission or an upload automatically.
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        if (page.url().startsWith('chrome-error:')) fail('BROWSER_ERROR_PAGE', 'Браузер открыл страницу сетевой ошибки');
        if (response && response.status() >= 400) fail('NAVIGATION_HTTP_ERROR', `Страница вернула HTTP ${response.status()}`);
        break;
      } catch (error) {
        guard();
        if (attempt >= 3 || !(error.code === 'BROWSER_ERROR_PAGE' || /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(error.message))) throw error;
        await abortableDelay(1000, activeSignal);
      }
    }
    return page.url();
  };
  register('navigate', async ({ params }) => {
    await goTo(params.url);
    return phase('navigate', 'verified', { current_url: page.url() });
  });
  register('auth_ecp', async ({ params }) => {
    await flow(requireValue(params.steps, 'auth_ecp.steps'));
    let certificate = { certificate_selected: false };
    if (ui.certificate_rows_selector) {
      await page.waitForFunction((url, selector) => location.href.startsWith(url)
        || [...document.querySelectorAll(selector)].some(e => e.getClientRects().length > 0),
      { timeout: 30000, signal: activeSignal }, config.authenticated_url, ui.certificate_rows_selector);
      if (!page.url().startsWith(config.authenticated_url)) {
        try {
          certificate = await selectSbisCertificate(page, { inn: config.certificate_inn || config.inn,
            selector: ui.certificate_rows_selector, unusableSelector: ui.certificate_unusable_selector, signal: activeSignal });
        } catch (error) {
          if (['CERTIFICATE_NOT_FOUND', 'CERTIFICATE_AMBIGUOUS'].includes(error.code)) fail(error.code, error.message);
          throw error;
        }
        phase('select_certificate', 'verified', certificate);
      } else if (config.certificate_selection_required === true) {
        fail('CERTIFICATE_NOT_VERIFIED', 'СБИС выполнил вход без явного выбора подписи; сертификат не подтверждён');
      }
    } else if (config.certificate_selection_required === true) fail('UI_BINDING_REQUIRED', 'Не настроен ui.certificate_rows_selector');
    if (ui.certificate_after_steps?.length) await flow(ui.certificate_after_steps);
    const waitForLoginOrSetup = () => page.waitForFunction((url) => location.href.startsWith(url)
      || (document.body?.innerText || '').includes('Настройка безопасности')
      || (document.body?.innerText || '').includes('Регистрация ИП')
      || (document.body?.innerText || '').includes('Регистрация организации'),
    { timeout: 30000, signal: activeSignal }, config.authenticated_url);
    await waitForLoginOrSetup();
    const setupState = () => page.evaluate(() => ({
      security: (document.body?.innerText || '').includes('Настройка безопасности'),
      registration: (document.body?.innerText || '').includes('Регистрация ИП') || (document.body?.innerText || '').includes('Регистрация организации'),
    }));
    let setup = await setupState();
    if (setup.security && !page.url().startsWith(config.authenticated_url)) {
      if (config.skip_security_setup !== true) {
        phase('auth_ecp', 'partial', { authenticated: false, ...certificate, reason: 'security_setup_required' });
        fail('AUTH_SECURITY_SETUP_REQUIRED', 'СБИС требует настройку безопасности; пропуск не разрешён параметром skip_security_setup');
      }
      await flow([{ type: 'waitForElement', selectors: [['text/Пропустить']], visible: true },
        { type: 'click', selectors: [['text/Пропустить']], offsetX: 55, offsetY: 20 }]);
      certificate.security_setup_skipped = true;
      await page.waitForFunction((url) => location.href.startsWith(url)
        || (document.body?.innerText || '').includes('Регистрация ИП') || (document.body?.innerText || '').includes('Регистрация организации'),
      { timeout: 30000, signal: activeSignal }, config.authenticated_url);
      setup = await setupState();
    }
    if (setup.registration && !page.url().startsWith(config.authenticated_url)) {
      phase('auth_ecp', 'partial', { authenticated: false, ...certificate, reason: 'account_setup_required' });
      fail('AUTH_ACCOUNT_SETUP_REQUIRED', 'Для выбранной подписи СБИС требует первичную регистрацию кабинета (телефон или почту)');
    }
    await page.waitForFunction((url) => location.href.startsWith(url), { timeout: 30000, signal: activeSignal }, config.authenticated_url);
    return phase('auth_ecp', 'verified', { authenticated: true, ...certificate });
  });
  register('select_authority', async ({ params }) => {
    const plan = plans.find((p) => p.authority === params.authority);
    config = { ...baseConfig, authority: plan.authority, prefixes: plan.prefixes };
    ui = { ...(baseConfig.ui || {}), ...(plan.ui || {}) };
    config.ui = ui;
    reports = allReports.filter((r) => r.authority === config.authority);
    organizationVerified = false;
    authorityStates.set(config.authority, 'running');
    const authorityPath = ui.authority_paths?.[config.authority];
    if (authorityPath) await goTo(new URL(authorityPath, config.report_url).href);
    else await flow([clickText({ FNS: 'Налоговая', SFR: 'СФР', ROSSTAT: 'Статистика' }[config.authority])]);
    if (ui.authority_steps?.length) await flow(ui.authority_steps);
    if (authorityPath) await page.waitForFunction((expected) => location.pathname === expected,
      { timeout: 30000, signal: activeSignal }, authorityPath);
    if (ui.organization_steps?.length) await flow(ui.organization_steps);
    if (ui.organization_selector) {
      const text = await visibleText(ui.organization_selector);
      organizationVerified = containsInn(text, config.inn);
      phase('organization_identity', organizationVerified ? 'verified' : 'failed', {
        authority: config.authority, organization_verified: organizationVerified });
    }
    if (ui.organization_after_steps?.length) await flow(ui.organization_after_steps);
    if (ui.organization_steps?.length && authorityPath) {
      await goTo(new URL(authorityPath, config.report_url).href);
      if (ui.authority_steps?.length) await flow(ui.authority_steps);
    }
    const authorityVerified = Boolean(authorityPath) && new URL(page.url()).pathname === authorityPath;
    await dismissHints();
    await snapshot(`authority-${config.authority}`);
    if (!organizationVerified && (!probe || ui.organization_selector)) fail('ORGANIZATION_NOT_VERIFIED', 'Не подтверждена выбранная организация по ИНН');
    return phase('select_authority', organizationVerified && authorityVerified ? 'verified' : 'partial', {
      authority: config.authority, current_url: page.url(), authority_selected: true, reports_section_verified: authorityVerified, organization_verified: organizationVerified,
      ...(!organizationVerified ? { reason: 'Не настроена проверка выбранной организации по ИНН' } : {}) });
  });
  register('find_files', async () => {
    if (!filesPrepared) {
      // Resolve every prefix before the first upload; reject cross-authority overlap.
      const selected = new Set();
      const prepared = [];
      for (const plan of plans) {
        const files = await findLatestReports({ ...baseConfig, prefixes: plan.prefixes }, allowedRoots);
        for (const file of files) {
          const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
          if (selected.has(key)) fail('AUTHORITY_FILE_CONFLICT', 'Один XML выбран для нескольких ведомств', { filename: file.filename });
          selected.add(key);
          prepared.push({ ...file, authority: plan.authority, state: 'selected', validation_result: null, sbis_status: null });
        }
      }
      allReports.push(...prepared);
      filesPrepared = true;
    }
    reports = allReports.filter((r) => r.authority === config.authority);
    return phase('find_files', 'verified', { found_files: reports.map((f) => f.path) });
  });
  register('upload_files', async () => {
    if (probe) return phase('upload_files', 'skipped', { reason: 'preflight: реальная отчётная форма не передаётся' });
    if (!organizationVerified) fail('ORGANIZATION_NOT_VERIFIED', 'Организация не подтверждена');
    const uploadSteps = requireValue(ui.upload_steps?.length && ui.upload_steps, 'ui.upload_steps');
    for (const [index, r] of reports.entries()) {
      guard();
      if (index > 0 && ui.report_identity_mode === 'selected_file_and_key') {
        // Close only the previously verified card before starting the next import.
        await requireReportIdentity(reports[index - 1]);
        await goTo(new URL(ui.authority_paths[config.authority], config.report_url).href);
        if (ui.authority_steps?.length) await flow(ui.authority_steps);
      }
      const actual = await checkedPath(r.path, allowedRoots);
      if (hash(await readFile(actual)) !== r.sha256) fail('SOURCE_CHANGED', 'XML изменён после поиска');
      if (ui.report_identity_mode === 'selected_file_and_key' && await visibleCards(reportSelector(r))) {
        fail('REPORT_IDENTITY_MISMATCH', 'Перед импортом уже открыта карточка: невозможно подтвердить результат нового импорта');
      }
      r.file_selection_verified = Boolean(await flow(uploadSteps, reportContext(r)));
      await requireReportIdentity(r, { capture: true });
      r.load_datetime = new Date().toISOString();
      r.state = 'uploaded';
      // Each file is validated in its own card before another is opened.
      await validateOne(r);
    }
    return phase('upload_files', 'verified', { uploaded_count: reports.length });
  });
  async function validateOne(r) {
    const cardScope = await requireReportIdentity(r);
    const scope = resolveTemplates(ui.validation_scope_selector || cardScope, { ...config, ...reportContext(r) });
    await flow(requireValue(ui.validate_steps?.length && ui.validate_steps, 'ui.validate_steps'), reportContext(r));
    const statusSelector = requireValue(ui.validation_status_selector, 'ui.validation_status_selector');
    const protocolSelector = requireValue(ui.protocol_selector, 'ui.protocol_selector');
    const successText = requireValue(ui.validation_success_text, 'ui.validation_success_text');
    const failureText = requireValue(ui.validation_failure_text, 'ui.validation_failure_text');
    await page.waitForFunction((scope, selector, ok, bad) => {
      const roots = [...document.querySelectorAll(scope)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (roots.length !== 1) return false;
      const matches = [...roots[0].querySelectorAll(selector)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && [ok, bad].includes(e.innerText?.trim()));
      return matches.length === 1;
    }, { timeout: config.validation_timeout_ms || 300000, signal: activeSignal }, scope, statusSelector, successText, failureText);
    const status = await page.evaluate((scope, selector, ok, bad) => {
      const roots = [...document.querySelectorAll(scope)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (roots.length !== 1) return null;
      const matches = [...roots[0].querySelectorAll(selector)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && [ok, bad].includes(e.innerText?.trim()));
      return matches.length === 1 ? matches[0].innerText.trim() : null;
    }, scope, statusSelector, successText, failureText);
    if (!status) fail('VALIDATION_RESULT_AMBIGUOUS', 'Не подтверждён единственный результат проверки');
    const protocol = await visibleText(`${scope} ${protocolSelector}`);
    if (!protocol.trim()) fail('PROTOCOL_EMPTY', 'Пустой протокол проверки');
    await requireReportIdentity(r);
    r.validation_result = status;
    r.protocol = await artifact(`validation-${r.authority}-${allReports.indexOf(r) + 1}-${Date.now()}.txt`, protocol, 'text/plain');
    r.state = status === successText ? 'validated' : 'validation_failed';
  }
  register('validate_report', async () => {
    if (probe) return phase('validate_report', 'skipped', { reason: 'preflight' });
    if (reports.some((r) => r.state !== 'validated')) {
      // Continue only to collect a result; conditional_submit will not send any file.
      return phase('validate_report', 'validation_failed', { validation_result: 'Есть ошибки проверки' });
    }
    return phase('validate_report', 'verified', { validation_result: 'Ошибок не обнаружено' });
  });
  register('conditional_submit', async () => {
    if (probe || config.mode !== 'send' || config.submit_enabled !== true) return phase('conditional_submit', 'skipped', { reason: 'Отправка отключена' });
    if (!reports.length || reports.some((r) => r.state !== 'validated' || !r.protocol)) {
      return phase('conditional_submit', 'skipped', { reason: 'Не все файлы прошли проверку' });
    }
    const reopen = requireValue(ui.reopen_steps?.length && ui.reopen_steps, 'ui.reopen_steps');
    const submit = requireValue(ui.submit_steps?.length && ui.submit_steps, 'ui.submit_steps');
    const statusSelector = requireValue(ui.sent_status_selector, 'ui.sent_status_selector');
    for (const r of reports) {
      await flow(reopen, reportContext(r));
      const scope = await requireReportIdentity(r);
      // Revalidate the exact card immediately before submission, not a stale DOM result.
      await validateOne(r);
      if (r.state !== 'validated') fail('VALIDATION_ERROR', 'Проверка перед отправкой обнаружила ошибки');
      submissionStarted = true;
      r.state = 'submission_unknown';
      await flow(submit, reportContext(r));
      await page.waitForFunction((scope, selector) => document.querySelector(scope)?.querySelector(selector)?.innerText?.trim() === 'Отправлен',
        { timeout: config.submit_timeout_ms || 300000, signal: activeSignal }, scope, statusSelector);
      r.sbis_status = 'Отправлен';
      r.state = 'sent';
    }
    return phase('conditional_submit', 'verified', { sent_count: reports.length });
  });
  const completedState = (items) => probe ? 'preflight_completed' : items.some((r) => r.state === 'validation_failed') ? 'validation_failed'
    : items.length && items.every((r) => r.state === 'archived') ? 'sent' : 'validated_not_sent';
  register('move_files', async () => {
    if (probe || !reports.length || reports.some((r) => r.state !== 'sent' || r.sbis_status !== 'Отправлен')) {
      authorityStates.set(config.authority, completedState(reports));
      return phase('move_files', 'skipped', { reason: 'Нет подтверждения отправки всех файлов' });
    }
    const dir = await checkedPath(config.loaded_dir, allowedRoots, { directory: true });
    for (const r of reports) {
      // Copy evidence first and retain its API artifact; move the source only after that.
      const protocolPath = path.join(dir, `${r.filename}.${jobId}.validation.txt`);
      await copyFile(r.protocol.local_path, protocolPath, constants.COPYFILE_EXCL);
      r.archived_path = await archiveReport(r, dir, allowedRoots);
      r.archived_protocol = protocolPath;
      r.state = 'archived';
    }
    authorityStates.set(config.authority, completedState(reports));
    return phase('move_files', 'verified', { moved_count: reports.length });
  });
  const resultFields = (state) => ({ state, inn: config.inn, authority: plans.length === 1 ? plans[0].authority : null, mode: config.mode,
    authorities: plans.map((p) => ({ authority: p.authority, prefixes: p.prefixes, state: authorityStates.get(p.authority),
      report_count: allReports.filter((r) => r.authority === p.authority).length })),
    reports: allReports.map((r) => ({ authority: r.authority, file_name: r.filename, sha256: r.sha256, state: r.state,
      load_datetime: r.load_datetime || null, validation_result: r.validation_result,
      file_selection_verified: Boolean(r.file_selection_verified), report_key_verified: Boolean(r.report_key),
      validation_protocol: r.protocol?.public_url || null, sbis_status: r.sbis_status,
      archived_path: r.archived_path || null })), phases });
  register('return_result', async () => {
    const state = completedState(allReports);
    phase('return_result', 'verified');
    return { Rezult_1: resultFields(state) };
  });
  // Execute the expanded plan with the regular registry after validating the public template.
  const executionScript = { ...script, format: undefined, steps: [
    ...script.steps.slice(0, 5),
    ...plans.flatMap((plan) => script.steps.slice(5, 11).map((step) => ({ ...step,
      id: `${plan.authority}_${step.action}`, title: `${plan.authority}: ${step.title || step.action}`,
      params: { ...(step.params || {}), authority: plan.authority },
    }))),
    script.steps[11]
  ] };
  try {
    const result = await executeScript({ script: executionScript, registry, initialContext: baseConfig, signal, defaultStepTimeoutMs: 60000,
      onEvent: (event) => onEvent(event.type === 'script_started' ? { ...event, execution_steps: executionScript.steps } : event) });
    await snapshot('sbis-final');
    result.context.artifacts = artifacts;
    if (result.context.Rezult_1.state === 'validation_failed') {
      const error = new InterpreterError('VALIDATION_ERROR', 'СБИС обнаружил ошибки отчётности');
      error.partial_context = result.context;
      throw error;
    }
    return result;
  } catch (error) {
    await snapshot('sbis-error');
    if (authorityStates.get(config.authority) === 'running') authorityStates.set(config.authority, submissionStarted ? 'requires_reconciliation' : 'failed');
    error.retryable = false; // A job-level retry could duplicate a previously submitted report.
    error.partial_context = { ...(error.partial_context || {}), artifacts,
      Rezult_1: resultFields(submissionStarted ? 'requires_reconciliation' : error.code === 'VALIDATION_ERROR' ? 'validation_failed' : 'failed') };
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
  }
}
