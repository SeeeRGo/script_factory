import { parse } from '@puppeteer/replay';

// Replay 4 validates Recorder timeouts against 30s although its runner accepts
// longer waits. Validate our timeout contract, then retain Replay's structural
// validation without changing the installed dependency or caller's recording.
export function parseReplayWithTimeouts(recording) {
  const normalize = (object, label) => {
    if (!object || typeof object !== 'object' || !Object.hasOwn(object, 'timeout')) return object;
    if (!Number.isSafeInteger(object.timeout) || object.timeout < 1 || object.timeout > 2147483647) {
      throw new Error(`${label}.timeout: требуется целое число 1..2147483647 мс (диапазон таймера Node.js)`);
    }
    return { ...object, timeout: Math.min(object.timeout, 30000) };
  };
  const input = normalize(recording, 'recording');
  const bounded = input && Array.isArray(input.steps)
    ? { ...input, steps: input.steps.map((step, i) => normalize(step, `steps[${i}]`)) }
    : input;
  const parsed = parse(bounded);
  if (Object.hasOwn(recording, 'timeout')) parsed.timeout = recording.timeout;
  parsed.steps.forEach((step, i) => {
    if (Object.hasOwn(recording.steps[i], 'timeout')) step.timeout = recording.steps[i].timeout;
  });
  return parsed;
}
