// An explicit format keeps real SBIS workflows separate from legacy demo actions.
export const SBIS_ACTIONS = [
  'check_ip', 'launch_browser', 'navigate', 'auth_ecp', 'navigate',
  'select_authority', 'find_files', 'upload_files', 'validate_report',
  'conditional_submit', 'move_files', 'return_result'
];

export function validateSbisScript(script) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!Array.isArray(script.steps) || script.steps.length !== SBIS_ACTIONS.length) {
    add('script.steps', 'sbis-report требует полный список из 12 этапов');
    return errors;
  }
  script.steps.forEach((step, i) => {
    if (step?.action !== SBIS_ACTIONS[i]) add(`script.steps[${i}].action`, `Ожидается ${SBIS_ACTIONS[i]}`);
    if (step?.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 1)) {
      add(`script.steps[${i}].timeout_ms`, 'Тайм-аут должен быть положительным целым числом');
    }
  });
  return errors;
}
