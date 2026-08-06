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
  assert.equal(browserScenario.payload.script.steps.length, 20);
  assert.ok(browserScenario.payload.script.steps.every((step) => typeof step.type === 'string'));
  assert.equal(browserScenario.payload.context.mail_to, '10sydneyfc@gmail.com');
  const consentStep = browserScenario.payload.script.steps.find((step) => step.title.includes('условия Yahoo'));
  assert.equal(consentStep.type, 'waitForExpression');
  assert.match(consentStep.expression, /guce\.yahoo\.com/);
  assert.match(consentStep.expression, /alles accepteren/i);

  let consentClicks = 0;
  const acceptButton = {
    name: '',
    value: '',
    innerText: 'Alles accepteren',
    classList: { contains: () => false },
    click: () => { consentClicks += 1; }
  };
  const evaluateConsent = new Function(
    'location',
    'document',
    'globalThis',
    'window',
    `return ${consentStep.expression}`
  );
  const consentPage = { hostname: 'guce.yahoo.com' };
  const consentDocument = { querySelectorAll: () => [acceptButton] };
  const pageState = {};
  assert.equal(evaluateConsent(consentPage, consentDocument, pageState, {}), false);
  assert.equal(consentClicks, 1);
  assert.equal(evaluateConsent(consentPage, consentDocument, pageState, {}), false);
  assert.equal(consentClicks, 1, 'кнопка consent не должна нажиматься повторно');
  assert.equal(evaluateConsent({ hostname: 'mail.yahoo.com' }, consentDocument, pageState, {}), true);

  const makeRadio = (name, value) => ({
    name,
    value,
    id: `${name}-${value}`,
    checked: false,
    labels: [],
    getAttribute: () => null,
    click() { this.checked = true; }
  });
  const mailboxRadios = [makeRadio('smart', 'reject'), makeRadio('smart', 'allow'), makeRadio('ads', 'reject'), makeRadio('ads', 'allow')];
  let submitClicks = 0;
  const submitButton = {
    innerText: 'Doorgaan',
    value: '',
    type: 'submit',
    disabled: false,
    classList: { contains: () => false },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    click: () => { submitClicks += 1; }
  };
  const mailboxDocument = {
    documentElement: { scrollHeight: 1200 },
    querySelectorAll: (selector) => {
      if (selector === 'input[type="radio"]') return mailboxRadios;
      if (selector.startsWith('[role="radio"]')) return [];
      if (selector === 'label') return [];
      return [submitButton];
    }
  };
  const mailboxWindow = { scrollTo: () => {} };
  const mailboxState = {};
  assert.equal(evaluateConsent({ hostname: 'consent.yahoo.com' }, mailboxDocument, mailboxState, mailboxWindow), false);
  assert.equal(mailboxRadios.filter((radio) => radio.checked).length, 2);
  assert.equal(evaluateConsent({ hostname: 'consent.yahoo.com' }, mailboxDocument, mailboxState, mailboxWindow), false);
  assert.equal(submitClicks, 1);

  const onboardingStep = browserScenario.payload.script.steps.find((step) => step.title === 'Подготовить интерфейс Mail');
  assert.equal(onboardingStep.type, 'waitForExpression');
  const evaluateOnboarding = new Function('location', 'document', 'globalThis', `return ${onboardingStep.expression}`);
  const composeButton = { getBoundingClientRect: () => ({ width: 120, height: 32 }) };
  const readyMailDocument = {
    querySelector: () => composeButton,
    querySelectorAll: () => []
  };
  assert.equal(evaluateOnboarding({ hostname: 'mail.yahoo.com' }, readyMailDocument, {}), true);
  const newMessageButton = {
    innerText: 'New message',
    getBoundingClientRect: () => ({ width: 180, height: 48 })
  };
  const redesignedMailDocument = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'a, button' ? [newMessageButton] : []
  };
  assert.equal(evaluateOnboarding({ hostname: 'mail.yahoo.com' }, redesignedMailDocument, {}), true);

  const yandexScenario = demoScenarios.find((scenario) => scenario.id === 'yandex-search-replay');
  assert.ok(yandexScenario);
  assert.equal(yandexScenario.payload.script.steps.length, 11);
  assert.equal(yandexScenario.payload.context.search_query, 'официальная документация Node.js');
  const searchSubmitStep = yandexScenario.payload.script.steps.find((step) => step.title === 'Запустить поиск');
  assert.deepEqual({ type: searchSubmitStep.type, key: searchSubmitStep.key }, { type: 'keyDown', key: 'Enter' });
});

test('blank editor template is a valid starting point', () => {
  assert.deepEqual(validateScript(blankScenario.script), []);
  assert.equal(blankScenario.script.title, 'Новый сценарий Chrome Recorder');
  assert.equal(blankScenario.script.steps.length, 2);
  assert.ok(blankScenario.script.steps.every((step) => step.title && step.description));
});
