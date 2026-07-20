import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(demoDirectory);
const dataDirectory = path.join(projectDirectory, 'demo-data');

export async function resetDemoData() {
  const incomingDirectory = path.join(dataDirectory, 'incoming');
  const loadedDirectory = path.join(dataDirectory, 'loaded');
  const emptyDirectory = path.join(dataDirectory, 'empty');

  await rm(incomingDirectory, { recursive: true, force: true });
  await rm(loadedDirectory, { recursive: true, force: true });
  await rm(emptyDirectory, { recursive: true, force: true });
  await mkdir(incomingDirectory, { recursive: true });
  await mkdir(loadedDirectory, { recursive: true });
  await mkdir(emptyDirectory, { recursive: true });
  await cp(path.join(demoDirectory, 'fixtures'), incomingDirectory, { recursive: true });

  return { incomingDirectory, loadedDirectory, emptyDirectory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = await resetDemoData();
  console.log('Демо-данные восстановлены:', directories);
}
