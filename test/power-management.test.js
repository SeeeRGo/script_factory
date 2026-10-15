import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assessPowerSnapshot, createPowerManager, createWindowsPowerAdapter, powerDefaults, powerWorkBlockers, validatePowerConfig } from '../src/power-management.js';
const defaults = () => ({ ...powerDefaults({}), enabled: true, dry_run: false, grace_seconds: 0 });
const snapshot = (sessions = []) => ({ complete: true, excluded_sid: 'S-1-5-21-robot', suspend_supported: true, suspend_privilege: true, sessions });
const user = (idle, state = 'active') => ({ id: 2, account: 'TEST\\User', account_sid: 'S-1-5-21-user', state, idle_seconds: idle });
async function setup(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'power-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let sleeps = 0, inspections = 0;
  const manager = await createPowerManager({ dataDir: root, defaults: defaults(),
    adapter: { supported: true, inspect: async () => { inspections++; return snapshot([user(2000)]); }, suspend: async () => { sleeps++; return { suspended: true }; } },
    ...overrides });
  t.after(() => manager.close());
  return { root, manager, sleeps: () => sleeps, inspections: () => inspections };
}
test('power settings validate types, bounds, account and environment defaults', () => {
  const initial = powerDefaults({}); assert.equal(initial.enabled, false); assert.equal(initial.background_enabled, false); assert.equal(initial.dry_run, true);
  for (const patch of [{ enabled: 'true' }, { user_idle_seconds: 0 }, { check_interval_seconds: 1 }, { dry_run: null }, { excluded_user: '' }, { excluded_user: '-Command' }, { excluded_user: 'x\nexit' }, { forced: true }]) assert.throws(() => validatePowerConfig(patch, initial), { code: 'INVALID_POWER_CONFIG' });
  assert.throws(() => powerDefaults({ POWER_ENABLED: 'yes' }), { code: 'INVALID_POWER_CONFIG' });
  assert.equal(validatePowerConfig({ excluded_user: 'DOMAIN\\Robot', user_idle_seconds: 600 }, initial).user_idle_seconds, 600);
});
test('session policy excludes the configured SID and requires every other session to exceed threshold', () => {
  const config = defaults();
  assert.equal(assessPowerSnapshot(snapshot([{ ...user(null), account_sid: 'S-1-5-21-robot' }]), config), null);
  for (const state of ['active', 'connected', 'disconnected']) {
    assert.equal(assessPowerSnapshot(snapshot([user(1800, state)]), config), 'USER_ACTIVE');
    assert.equal(assessPowerSnapshot(snapshot([user(1801, state)]), config), null);
  }
  assert.equal(assessPowerSnapshot(snapshot([user(9000), user(1)]), config), 'USER_ACTIVE');
  for (const value of [snapshot([user(null)]), snapshot([user(-1)]), snapshot([user(8000, 'unknown')]), { ...snapshot(), complete: false }, { ...snapshot(), excluded_sid: '' }]) assert.equal(assessPowerSnapshot(value, config), 'SESSION_DATA_UNAVAILABLE');
  assert.equal(assessPowerSnapshot({ ...snapshot(), suspend_supported: false }, config), 'SUSPEND_UNSUPPORTED');
  assert.equal(assessPowerSnapshot({ ...snapshot(), suspend_privilege: false }, config), 'POWER_PRIVILEGE_MISSING');
});
test('queued, running, retrying work and pending transfers/callbacks prevent even session inspection', async t => {
  for (const reason of ['JOBS_PENDING', 'CALLBACK_PENDING', 'ARTIFACT_TRANSFER']) {
    const o = await setup(t, { getBlockers: () => [reason] });
    await o.manager.request(); assert.equal(o.inspections(), 0); assert.equal(o.sleeps(), 0); assert.equal(o.manager.status().last.reason, reason);
  }
});
test('one coalesced check performs fresh sessions and persistence under admission lock, then releases after resume', async t => {
  let unlock, calls = 0, persisted = false, manager;
  const sleeping = new Promise(resolve => { unlock = resolve; });
  const o = await setup(t, { beforeSuspend: async () => { persisted = true; assert.equal(manager.committing, true); },
    adapter: { supported: true, inspect: async () => snapshot(), suspend: async () => { calls++; assert.ok(persisted); assert.throws(() => manager.assertAcceptingWork(), { code: 'POWER_TRANSITION_IN_PROGRESS' }); await sleeping; return { suspended: true }; } } });
  manager = o.manager;
  const first = manager.request(), second = manager.request(); assert.equal(first, second);
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  unlock(); await first; assert.equal(calls, 1); assert.equal(manager.committing, false); manager.assertAcceptingWork();
  await manager.request(); assert.equal(calls, 1); assert.equal(manager.status().last.reason, 'RESUME_COOLDOWN');
});
test('new work during grace cancels sleep and checks begun before a user becomes active never suspend', async t => {
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const o = await setup(t, { wait: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  const checking = o.manager.request(); await enteredPromise; o.manager.notifyWork(); release(); await checking;
  assert.equal(o.sleeps(), 0); assert.equal(o.manager.status().last.state, 'cancelled');
  let inspections = 0, sleeps = 0;
  const next = await setup(t, { adapter: { supported: true, inspect: async () => snapshot([user(++inspections === 1 ? 8000 : 0)]), suspend: async () => { sleeps++; } } });
  await next.manager.request(); assert.equal(sleeps, 0); assert.equal(next.manager.status().last.reason, 'USER_ACTIVE');
});
test('work appearing during async probe or durable flush prevents suspend', async t => {
  for (const stage of ['inspect', 'persist']) {
    let busy = false;
    const o = await setup(t, { getBlockers: () => busy ? ['JOBS_PENDING'] : [],
      beforeSuspend: async () => { if (stage === 'persist') busy = true; },
      adapter: { supported: true, inspect: async () => { if (stage === 'inspect') busy = true; return snapshot(); }, suspend: async () => { assert.fail('must not sleep'); } } });
    await o.manager.request(); assert.equal(o.manager.committing, false); assert.equal(o.manager.status().last.reason, 'JOBS_PENDING');
  }
});
test('dry run and native final rejection do not report a suspended machine', async t => {
  const dry = await setup(t, { defaults: { ...defaults(), dry_run: true } }); await dry.manager.request(); assert.equal(dry.sleeps(), 0); assert.equal(dry.manager.status().last.reason, 'WOULD_SUSPEND');
  const native = await setup(t, { adapter: { supported: true, inspect: async () => snapshot(), suspend: async () => ({ suspended: false, reason: 'USER_ACTIVE' }) } });
  await native.manager.request(); assert.equal(native.manager.status().last.state, 'blocked'); assert.equal(native.manager.status().last.reason, 'USER_ACTIVE');
});
test('settings survive restart, concurrent patches merge, and changing settings cancels pending sleep', async t => {
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const o = await setup(t, { wait: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  const pending = o.manager.request(); await enteredPromise;
  await Promise.all([o.manager.update({ user_idle_seconds: 99 }), o.manager.update({ excluded_user: 'TEST\\AnotherRobot', enabled: false })]);
  release(); await pending; assert.equal(o.sleeps(), 0); assert.equal(o.manager.config.user_idle_seconds, 99);
  await o.manager.close();
  const restarted = await createPowerManager({ dataDir: o.root, defaults: defaults(), adapter: { supported: true } });
  t.after(() => restarted.close()); assert.equal(restarted.config.excluded_user, 'TEST\\AnotherRobot'); assert.equal(restarted.config.enabled, false);
  const contents = JSON.parse(await readFile(path.join(o.root, 'power/config.json'), 'utf8')); assert.equal(contents.user_idle_seconds, 99);
  await writeFile(path.join(o.root, 'power/config.json'), '{broken');
  await assert.rejects(createPowerManager({ dataDir: o.root, defaults: defaults() }), { code: 'POWER_CONFIG_READ_FAILED' });
});
test('closed, disabled, unsupported and failed native calls cannot silently invoke sleep', async t => {
  const disabled = await setup(t, { defaults: { ...defaults(), enabled: false } }); assert.throws(() => disabled.manager.assertAvailable(), { code: 'POWER_DISABLED' }); await disabled.manager.request(); assert.equal(disabled.sleeps(), 0);
  const unsupported = await setup(t, { adapter: { supported: false } }); assert.throws(() => unsupported.manager.assertAvailable(), { code: 'POWER_OS_UNSUPPORTED' });
  const broken = await setup(t, { adapter: { supported: true, inspect: async () => { throw Object.assign(new Error(), { code: 'WINDOWS_POWER_ERROR' }); }, suspend: async () => assert.fail() } });
  await broken.manager.request(); assert.equal(broken.manager.status().last.state, 'error'); assert.equal(broken.manager.committing, false);
  await broken.manager.close(); await broken.manager.request(); assert.throws(() => broken.manager.assertAcceptingWork(), { code: 'POWER_STOPPING' });
});
test('Windows adapter uses fixed scripts, bounded inspection, literal account arguments and no shell', async () => {
  const seen = [];
  const adapter = createWindowsPowerAdapter({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async (file, args, options) => {
    seen.push({ file, args, options }); return { stdout: '\uFEFF' + JSON.stringify(snapshot()) };
  } });
  await adapter.inspect({ ...defaults(), excluded_user: 'DOMAIN\\Robot' });
  assert.match(seen[0].file, /WindowsPowerShell/); assert.equal(seen[0].options.shell, false); assert.equal(seen[0].options.timeout, 15000); assert.ok(seen[0].args.includes('DOMAIN\\Robot'));
  assert.equal(seen[0].args.includes('-Command'), false);
  await adapter.suspend(defaults()); assert.equal(seen[1].options.timeout, 0);
  await assert.rejects(createWindowsPowerAdapter({ platform: 'linux' }).inspect(defaults()), { code: 'POWER_OS_UNSUPPORTED' });
});

test('background mode runs without an API command and remains dry-run by default', async t => {
  const o = await setup(t, { defaults: { ...defaults(), background_enabled: true, dry_run: true, check_interval_seconds: 5 } });
  const until = Date.now() + 8000;
  while (o.manager.status().last.reason !== 'WOULD_SUSPEND' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(o.manager.status().last.source, 'background'); assert.equal(o.manager.status().last.reason, 'WOULD_SUSPEND'); assert.equal(o.sleeps(), 0);
  await o.manager.update({ background_enabled: false });
});


test('work blockers include recovered queued work, retry delays, finishing workers and callbacks', () => {
  for (const status of ['queued','running','retrying']) assert.deepEqual(powerWorkBlockers({jobs:[{status}]}),['JOBS_PENDING']);
  assert.deepEqual(powerWorkBlockers({running:1,jobs:[{status:'success'}]}),['JOBS_PENDING']);
  assert.deepEqual(powerWorkBlockers({transfers:1}),['ARTIFACT_TRANSFER']);
  for (const status of ['pending','delivering','retrying']) assert.deepEqual(powerWorkBlockers({jobs:[{status:'success',callback_delivery:{status}}]}),['CALLBACK_PENDING']);
  for (const status of ['failed','delivered']) assert.deepEqual(powerWorkBlockers({jobs:[{status:'success',callback_delivery:{status}}]}),[]);
});

test('automatic excluded account follows the API account after restart unless explicitly overridden', async t => {
  const original = await setup(t, { defaults: { ...defaults(), excluded_user: 'TEST\\Robot' } });
  await original.manager.update({ enabled: true, dry_run: true }); await original.manager.close();
  const moved = await createPowerManager({ dataDir: original.root, defaults: { ...defaults(), excluded_user: 'TEST\\Robot2' }, adapter: { supported: true } });
  t.after(() => moved.close()); assert.equal(moved.config.excluded_user, 'TEST\\Robot2');
  await moved.update({ excluded_user: 'TEST\\Custom' }); assert.equal(moved.config.excluded_user, 'TEST\\Custom');
  await moved.update({ excluded_user: null }); assert.equal(moved.config.excluded_user, 'TEST\\Robot2');
  const saved = JSON.parse(await readFile(path.join(original.root, 'power/config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'excluded_user'), false);
});
