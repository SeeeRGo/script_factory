export const WORKFLOW_ACTIONS = Object.freeze([
  'set', 'compute', 'assert', 'fail', 'if', 'for_each', 'call', 'wait',
  'system_ip_check', 'files_list', 'file_verify', 'file_archive', 'file_copy',
  'artifact_write', 'browser_launch', 'browser_steps', 'browser_eval', 'browser_wait', 'browser_screenshot'
]);
const timeoutTemplate = value => typeof value === 'string' && /^\{\{\s*[\w.]+\s*\}\}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z_]\w*$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
export function validateWorkflow(script) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!script || script.format !== 'json-workflow') return [{ path: 'script.format', message: 'Ожидается json-workflow' }];
  if (script.context != null && (typeof script.context !== 'object' || Array.isArray(script.context))) add('script.context', 'context должен быть объектом');
  if (script.output !== undefined && (!script.output || typeof script.output !== 'object' || Array.isArray(script.output))) add('script.output', 'output должен быть объектом');
  const routines = script.routines || {};
  if (typeof routines !== 'object' || Array.isArray(routines)) add('script.routines', 'routines должен быть объектом');
  const visit = (steps, path, depth = 0) => {
    if (depth > 25) { add(path, 'Слишком глубокая вложенность'); return; }
    if (!Array.isArray(steps)) { add(path, 'steps должен быть массивом'); return; }
    steps.forEach((step, i) => {
      const at = `${path}[${i}]`;
      if (!step || typeof step !== 'object' || Array.isArray(step)) { add(at, 'Шаг должен быть объектом'); return; }
      if (!WORKFLOW_ACTIONS.includes(step.action)) add(`${at}.action`, 'Неизвестная универсальная операция');
      if (step.params != null && (typeof step.params !== 'object' || Array.isArray(step.params))) add(`${at}.params`, 'params должен быть объектом');
      if (step.save_as !== undefined && !identifier(step.save_as)) add(`${at}.save_as`, 'save_as должен быть безопасным именем переменной');
      if (step.timeout_ms !== undefined && !timeoutTemplate(step.timeout_ms) && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 1)) add(`${at}.timeout_ms`, 'Требуется положительный тайм-аут');
      if (step.action === 'for_each') {
        if (!identifier(step.as)) add(`${at}.as`, 'Укажите имя переменной цикла');
        if (step.index_as !== undefined && !identifier(step.index_as)) add(`${at}.index_as`, 'Неверное имя индекса');
        visit(step.steps, `${at}.steps`, depth + 1);
      }
      if (step.action === 'if') {
        visit(step.then || [], `${at}.then`, depth + 1);
        visit(step.else || [], `${at}.else`, depth + 1);
      }
      if (step.action === 'call' && (!identifier(step.routine) || !Object.hasOwn(routines, step.routine))) add(`${at}.routine`, 'Неизвестная подпрограмма JSON');
      if (['compute', 'browser_eval', 'browser_wait'].includes(step.action) && typeof step.params?.expression !== 'string') add(`${at}.params.expression`, 'Укажите строку выражения');
    });
  };
  visit(script.steps, 'script.steps');
  for (const [name, steps] of Object.entries(routines)) {
    if (!identifier(name)) add(`script.routines.${name}`, 'Неверное имя подпрограммы');
    visit(steps, `script.routines.${name}`);
  }
  if (script.on_error !== undefined) visit(script.on_error, 'script.on_error');
  if (script.default_step_timeout_ms !== undefined && (!Number.isInteger(script.default_step_timeout_ms) || script.default_step_timeout_ms < 1)) add('script.default_step_timeout_ms', 'Требуется положительный тайм-аут');
  return errors;
}
export { identifier as workflowIdentifier };
