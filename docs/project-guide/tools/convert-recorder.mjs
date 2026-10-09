import { readFile, writeFile } from 'node:fs/promises';
import { parse } from '@puppeteer/replay';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Использование: node convert-recorder.mjs recording.json workflow.json');
const recording = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, ''));
parse(recording);
const timeout = recording.timeout || 30000;
await writeFile(destination, JSON.stringify({
  format: 'json-workflow', title: recording.title,
  default_step_timeout_ms: Math.max(60000, timeout + 30000), context: {},
  steps: [{ action: 'browser_launch', title: 'Запустить браузер' }, {
    action: 'browser_steps', title: 'Выполнить запись Recorder',
    params: { timeout_ms: timeout, steps: recording.steps }
  }], output: { Rezult_1: { state: 'completed' } }
}, null, 2) + '\n', { flag: 'wx' });
console.log(`Создан ${destination}; добавьте проверки результата и тайм-аут всего задания.`);
