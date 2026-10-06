import { parentPort, workerData } from 'node:worker_threads';
import { Script, createContext } from 'node:vm';
// No host objects enter the VM. The worker itself is terminated by its caller.
const source = `const context = JSON.parse(${JSON.stringify(workerData.data)}); (() => {try {const value=(${workerData.expression});if(value&&typeof value.then==='function'){value.catch?.(()=>{});throw new Error('compute принимает только синхронные выражения');}return JSON.stringify({ok:true,value});} catch(e) {return JSON.stringify({ok:false,error:{code:String(e.code||'EXPRESSION_ERROR'),message:String(e.message||'Ошибка выражения')}});}})()`;
try {
  const encoded = new Script(source).runInContext(createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } }));
  if (encoded.length > 16 * 1024 * 1024) throw new Error('Результат слишком велик');
  parentPort.postMessage(encoded);
} catch {
  parentPort.postMessage(JSON.stringify({ ok: false, error: { code: 'EXPRESSION_ERROR', message: 'Некорректное выражение' } }));
}
