import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

function validReleaseDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!match) return false;
  const [, day, month, year] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

test('package metadata is a consistent release source of truth', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('package-lock.json', rootUrl), 'utf8'));
  const openApi = await readFile(new URL('openapi.yaml', rootUrl), 'utf8');
  const openApiVersion = /^info:\r?\n(?:^[ \t]+.*\r?\n)*?^[ \t]+version:[ \t]*([^\r\n]+)/m
    .exec(openApi)?.[1]?.trim();

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(validReleaseDate(packageJson.releaseDate), true);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(openApiVersion, packageJson.version);
});
