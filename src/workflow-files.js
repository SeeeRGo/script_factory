import { constants } from 'node:fs';
import { copyFile, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { InterpreterError } from './interpreter.js';
const fail = (code, message) => { throw new InterpreterError(code, message); };
const inside = (file, root) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
export const fileHash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export async function checkedWorkflowPath(value, roots, directory = false) {
  if (typeof value !== 'string' || !value) fail('MISSING_PARAMETER', 'Не задан путь');
  const candidate = path.resolve(value);
  if (!roots.some(root => inside(candidate, path.resolve(root)))) fail('FILESYSTEM_ACCESS_DENIED', 'Путь вне разрешённых каталогов');
  let resolved;
  try { resolved = await realpath(candidate); } catch { fail('FILE_NOT_FOUND', 'Файл или каталог недоступен'); }
  const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root))));
  if (!realRoots.some(root => inside(resolved, root))) fail('FILESYSTEM_ACCESS_DENIED', 'Путь вне разрешённых каталогов');
  const info = await stat(resolved);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('INVALID_PATH', 'Неверный тип объекта файловой системы');
  return resolved;
}
export async function listWorkflowFiles(directory, roots, signal) {
  const dir = await checkedWorkflowPath(directory, roots, true);
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length > 10000) fail('WORKFLOW_LIMIT', 'Слишком много файлов в каталоге');
  const files = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isFile()) continue;
    const file = await checkedWorkflowPath(path.join(dir, entry.name), roots);
    const info = await stat(file);
    files.push({ path: file, filename: entry.name, size_bytes: info.size, modified_ms: info.mtimeMs, sha256: await fileHash(file) });
  }
  return files;
}
export async function verifyWorkflowFile(file, roots) {
  const source = await checkedWorkflowPath(file?.path, roots);
  if (!/^[0-9a-f]{64}$/i.test(file?.sha256 || '') || await fileHash(source) !== file.sha256) fail('SOURCE_CHANGED', 'Файл изменён после выбора');
  return source;
}
export async function archiveWorkflowFile(file, directory, roots, signal) {
  const source = await verifyWorkflowFile(file, roots);
  const dir = await checkedWorkflowPath(directory, roots, true);
  const destination = path.join(dir, path.basename(source));
  if (source === destination) fail('ARCHIVE_CONFLICT', 'Источник совпадает с архивом');
  signal?.throwIfAborted();
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (await fileHash(destination) !== file.sha256 || await fileHash(source) !== file.sha256) fail('SOURCE_CHANGED', 'Контрольная сумма изменилась; оригинал сохранён');
  signal?.throwIfAborted();
  await unlink(source);
  return destination;
}
export async function copyWorkflowFile(source, destination, roots, signal) {
  source = await checkedWorkflowPath(source, roots);
  const directory = await checkedWorkflowPath(path.dirname(destination), roots, true);
  const target = path.join(directory, path.basename(destination));
  signal?.throwIfAborted();
  await copyFile(source, target, constants.COPYFILE_EXCL);
  return target;
}
