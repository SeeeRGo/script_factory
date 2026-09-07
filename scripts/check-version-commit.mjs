import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const rootUrl = new URL('../', import.meta.url);
const staged = process.argv.includes('--staged');

function gitShow(spec) {
  return execFileSync('git', ['show', spec], {
    cwd: rootUrl,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  if (!match) throw new Error(`${label} должна иметь формат MAJOR.MINOR.PATCH`);
  return match.slice(1).map(Number);
}

function isGreater(next, previous) {
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > previous[index]) return true;
    if (next[index] < previous[index]) return false;
  }
  return false;
}

function parseReleaseDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!match) return null;
  const [, day, month, year] = match.map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) return null;
  return timestamp;
}

function openApiVersion(source) {
  return /^info:\r?\n(?:^[ \t]+.*\r?\n)*?^[ \t]+version:[ \t]*([^\r\n]+)/m.exec(source)?.[1]?.trim();
}

async function currentFile(path) {
  return staged ? gitShow(`:${path}`) : readFile(new URL(path, rootUrl), 'utf8');
}

try {
  const previousPackage = JSON.parse(gitShow('HEAD:package.json'));
  const nextPackage = JSON.parse(await currentFile('package.json'));
  const nextLock = JSON.parse(await currentFile('package-lock.json'));
  const nextOpenApi = await currentFile('openapi.yaml');
  const previous = parseVersion(previousPackage.version, 'Предыдущая версия');
  const next = parseVersion(nextPackage.version, 'Новая версия');

  if (!isGreater(next, previous)) {
    throw new Error(
      `Каждый коммит должен повышать version в package.json: ${previousPackage.version} → ${nextPackage.version}`
    );
  }
  const nextReleaseDate = parseReleaseDate(nextPackage.releaseDate);
  if (nextReleaseDate === null) {
    throw new Error('package.json.releaseDate должна быть реальной датой в формате DD.MM.YYYY');
  }
  const previousReleaseDate = parseReleaseDate(previousPackage.releaseDate);
  if (previousReleaseDate !== null && nextReleaseDate < previousReleaseDate) {
    throw new Error('Дата релиза не может быть раньше даты предыдущей версии');
  }
  if (nextLock.version !== nextPackage.version || nextLock.packages?.['']?.version !== nextPackage.version) {
    throw new Error('Версии в package.json и package-lock.json должны совпадать');
  }
  if (openApiVersion(nextOpenApi) !== nextPackage.version) {
    throw new Error('info.version в openapi.yaml должна совпадать с package.json.version');
  }

  console.log(`Версия коммита корректна: ${nextPackage.version}, релиз ${nextPackage.releaseDate}`);
} catch (error) {
  console.error(`\nПроверка версии не пройдена: ${error.message}`);
  console.error('Перед коммитом выполните: npm run version:bump -- patch');
  process.exit(1);
}
