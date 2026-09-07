import { readFile, writeFile } from 'node:fs/promises';

const rootUrl = new URL('../', import.meta.url);
const packageUrl = new URL('package.json', rootUrl);
const lockUrl = new URL('package-lock.json', rootUrl);
const openApiUrl = new URL('openapi.yaml', rootUrl);
const requestedBump = process.argv[2] || 'patch';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Поддерживается версия формата MAJOR.MINOR.PATCH, получено: ${value}`);
  return match.slice(1).map(Number);
}

function nextVersion(current, requested) {
  if (/^\d+\.\d+\.\d+$/.test(requested)) return requested;
  const [major, minor, patch] = parseVersion(current);
  if (requested === 'major') return `${major + 1}.0.0`;
  if (requested === 'minor') return `${major}.${minor + 1}.0`;
  if (requested === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('Укажите patch, minor, major или точную версию MAJOR.MINOR.PATCH');
}

function localReleaseDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${day}.${month}.${year}`;
}

const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));
const packageLock = JSON.parse(await readFile(lockUrl, 'utf8'));
const openApi = await readFile(openApiUrl, 'utf8');
const oldVersion = packageJson.version;
const version = nextVersion(oldVersion, requestedBump);

if (version === oldVersion) throw new Error(`Версия уже равна ${version}`);

packageJson.version = version;
packageJson.releaseDate = localReleaseDate();
packageLock.version = version;
packageLock.packages[''].version = version;

const updatedOpenApi = openApi.replace(
  /(^info:\r?\n(?:^[ \t]+.*\r?\n)*?^[ \t]+version:)[^\r\n]+/m,
  `$1 ${version}`
);
if (updatedOpenApi === openApi) throw new Error('Не удалось обновить info.version в openapi.yaml');

await Promise.all([
  writeFile(packageUrl, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(lockUrl, `${JSON.stringify(packageLock, null, 2)}\n`),
  writeFile(openApiUrl, updatedOpenApi)
]);

console.log(`Версия обновлена: ${oldVersion} → ${version}, дата релиза: ${packageJson.releaseDate}`);
