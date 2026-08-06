import assert from 'node:assert/strict';
import test from 'node:test';

import { blankScenario, demoScenarios } from '../public/scenarios.js';
import { validateScript } from '../src/interpreter.js';

test('homepage demo route includes Stage 3 and remains short enough to present', () => {
  assert.ok(demoScenarios.length >= 5);
  assert.equal(new Set(demoScenarios.map((scenario) => scenario.id)).size, demoScenarios.length);
  assert.ok(demoScenarios.reduce((total, scenario) => total + Number.parseInt(scenario.talkTime, 10), 0) <= 20);

  for (const scenario of demoScenarios) {
    assert.ok(scenario.title);
    assert.ok(scenario.runtime);
    assert.ok(scenario.result);
    assert.ok(scenario.points.length >= 3);
    assert.ok(scenario.payload.script.steps.length >= 10, `${scenario.id} должен выглядеть как полный рабочий процесс`);
    assert.ok(scenario.payload.script.steps.every((step) => step.title && step.description), `${scenario.id}: у каждого шага нужны title и description`);
    assert.deepEqual(validateScript(scenario.payload.script), [], scenario.id);
  }

  const browserScenario = demoScenarios.find((scenario) => scenario.id === 'browser-mail-replay');
  assert.ok(browserScenario);
  assert.equal(browserScenario.payload.script.steps.length, 18);
  assert.ok(browserScenario.payload.script.steps.every((step) => typeof step.type === 'string'));
  assert.equal(browserScenario.payload.context.mail_to, '10sydneyfc@gmail.com');

  const yandexScenario = demoScenarios.find((scenario) => scenario.id === 'yandex-search-replay');
  assert.ok(yandexScenario);
  assert.equal(yandexScenario.payload.script.steps.length, 10);
  assert.equal(yandexScenario.payload.context.search_query, 'официальная документация Node.js');
});

test('blank editor template is a valid starting point', () => {
  assert.deepEqual(validateScript(blankScenario.script), []);
  assert.equal(blankScenario.script.title, 'Новый сценарий Chrome Recorder');
  assert.equal(blankScenario.script.steps.length, 2);
  assert.ok(blankScenario.script.steps.every((step) => step.title && step.description));
});
