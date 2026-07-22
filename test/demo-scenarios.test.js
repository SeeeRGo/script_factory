import assert from 'node:assert/strict';
import test from 'node:test';

import { blankScenario, demoScenarios } from '../public/scenarios.js';
import { validateScript } from '../src/interpreter.js';

test('homepage demo route is short, complete, and made of valid scripts', () => {
  assert.equal(demoScenarios.length, 4);
  assert.equal(new Set(demoScenarios.map((scenario) => scenario.id)).size, demoScenarios.length);
  assert.equal(demoScenarios.reduce((total, scenario) => total + Number.parseInt(scenario.talkTime, 10), 0), 11);

  for (const scenario of demoScenarios) {
    assert.ok(scenario.title);
    assert.ok(scenario.runtime);
    assert.ok(scenario.result);
    assert.ok(scenario.points.length >= 3);
    assert.deepEqual(validateScript(scenario.payload.script), [], scenario.id);
  }
});

test('blank editor template is a valid starting point', () => {
  assert.deepEqual(validateScript(blankScenario.script), []);
  assert.equal(blankScenario.script.steps.length, 1);
});
