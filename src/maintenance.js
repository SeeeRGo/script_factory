import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export async function createMaintenance({ dataDir, getBlockers = () => [], onEnter = () => {} }) {
  const dir = path.join(dataDir, 'maintenance'), file = path.join(dir, 'state.json');
  await mkdir(dir, { recursive: true });
  let state = { active: false }, writing = false;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw error('MAINTENANCE_STATE_INVALID', 'Не удалось прочитать состояние обслуживания', 503); }
  if (typeof state.active !== 'boolean' || (state.active && (!/^[A-Za-z0-9_-]{1,100}$/.test(state.owner) || !['draining', 'installing'].includes(state.phase)))) throw error('MAINTENANCE_STATE_INVALID', 'Повреждено состояние обслуживания', 503);
  const snapshot = () => ({ ...state, blockers: getBlockers(), ready_to_update: state.active && !writing && getBlockers().length === 0 });
  const assertOwner = owner => { if (!state.active || state.owner !== owner) throw error('MAINTENANCE_OWNER_MISMATCH', 'Обслуживание принадлежит другой операции'); };
  async function change(next) {
    if (writing) throw error('MAINTENANCE_BUSY', 'Изменение обслуживания ещё сохраняется');
    const previous = state;
    // Close admission synchronously before the first await; release it only after durable exit.
    if (next.active) state = next;
    writing = true;
    try {
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      await rename(temp, file);
      const handle = await open(process.platform === 'win32' ? file : dir, process.platform === 'win32' ? 'r+' : 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      state = next;
    } catch (e) { state = previous; throw e; }
    finally { writing = false; }
    return snapshot();
  }
  return {
    get active() { return state.active; },
    get sealed() { return state.active && state.phase === 'installing'; },
    snapshot, assertOwner,
    assertAdmission() { if (state.active) throw error('SERVICE_MAINTENANCE', 'УН на обслуживании; направьте задание на другую УН', 503); },
    assertTransfer() { if (state.active && state.phase === 'installing') throw error('SERVICE_MAINTENANCE', 'Установка обновления; повторите скачивание позже', 503); },
    async begin(owner, reason = 'Обновление API') {
      if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(owner) || typeof reason !== 'string' || reason.length > 200) throw error('INVALID_MAINTENANCE', 'Некорректный владелец или причина обслуживания', 400);
      if (state.active) { assertOwner(owner); return snapshot(); }
      onEnter();
      return change({ active: true, owner, reason, phase: 'draining', started_at: new Date().toISOString() });
    },
    async seal(owner) { assertOwner(owner); if (getBlockers().length) throw error('MAINTENANCE_NOT_DRAINED', 'Есть задания, callback или скачивания'); return change({ ...state, phase: 'installing' }); },
    async end(owner) { assertOwner(owner); if (getBlockers().length) throw error('MAINTENANCE_NOT_DRAINED', 'Дождитесь завершения проверок'); return change({ active: false }); }
  };
}
