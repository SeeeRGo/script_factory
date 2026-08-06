function receiptDownloadStep(durationMs) {
  return {
    id: 'receipt',
    action: 'download_files',
    params: {
      destination: '{{receipt_dir}}',
      files: [
        {
          filename: 'submission-receipt.pdf',
          source_url: 'https://online.sbis.ru/reports/receipt.pdf',
          mime_type: 'application/pdf',
          size_bytes: 48231,
          checksum_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        }
      ]
    },
    duration_ms: durationMs
  };
}

const stage3Subject = `Автоматизация Stage 3 · ${new Date().toLocaleString('ru-RU')}`;
const yandexQuery = 'официальная документация Node.js';
const yahooConsentExpression = `(() => {
  if (location.hostname !== 'guce.yahoo.com') return true;
  if (globalThis.__scriptFactoryYahooConsentClicked) return false;
  const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
  const accept = buttons.find((button) => button.name === 'agree'
    || button.value === 'agree'
    || button.classList.contains('accept-all')
    || /^(accept all|alles accepteren|принять все|alle akzeptieren|tout accepter|aceptar todo|accetta tutto)$/i
      .test((button.innerText || button.value || '').trim()));
  if (!accept) return false;
  globalThis.__scriptFactoryYahooConsentClicked = true;
  accept.click();
  return false;
})()`;

function browserMailReplay() {
  return {
    title: 'Этап 3 · Реальная отправка Yahoo → Gmail',
    timeout: 15000,
    steps: [
      { title: 'Настроить окно Chromium', description: 'Устанавливает презентационный размер окна перед открытием Yahoo.', type: 'setViewport', width: 1400, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { title: 'Открыть Yahoo', description: 'Переходит на актуальную страницу входа Yahoo Mail.', type: 'navigate', url: '{{yahoo_mail_url}}' },
      { title: 'Дождаться формы входа', description: 'Проверяет, что Yahoo показал поле имени пользователя.', type: 'waitForElement', selectors: [['#username'], ['input[name="username"]'], ['aria/Username, email, or mobile']], visible: true },
      { title: 'Выбрать поле логина', description: 'Устанавливает фокус в поле учётной записи Yahoo.', type: 'click', selectors: [['#username'], ['input[name="username"]']], offsetX: 150, offsetY: 24 },
      { title: 'Ввести адрес Yahoo', description: 'Вводит адрес отправителя из защищённой конфигурации сервера.', type: 'change', selectors: [['#username'], ['input[name="username"]']], value: '{{yahoo_login}}' },
      { title: 'Перейти к паролю', description: 'Нажимает Next и открывает второй этап авторизации Yahoo.', type: 'click', selectors: [['button[name="signin"]'], ['button[type="submit"]'], ['aria/Next']], offsetX: 150, offsetY: 24, assertedEvents: [{ type: 'navigation' }] },
      { title: 'Дождаться поля пароля', description: 'Ожидает пароль или завершает шаг ошибкой при CAPTCHA/дополнительной проверке.', type: 'waitForElement', selectors: [['#login-passwd'], ['input[name="password"]'], ['input[type="password"]']], visible: true },
      { title: 'Выбрать поле пароля', description: 'Устанавливает фокус в поле пароля Yahoo.', type: 'click', selectors: [['#login-passwd'], ['input[name="password"]'], ['input[type="password"]']], offsetX: 150, offsetY: 24 },
      { title: 'Ввести пароль Yahoo', description: 'Берёт пароль из YAHOO_MAIL_PASSWORD; значение скрывается в прогрессе и логах.', type: 'change', selectors: [['#login-passwd'], ['input[name="password"]'], ['input[type="password"]']], value: '{{yahoo_password}}' },
      { title: 'Войти в почту', description: 'Отправляет форму пароля и переходит в Yahoo Mail.', type: 'click', selectors: [['button[name="verifyPassword"]'], ['#login-signin'], ['button[type="submit"]'], ['aria/Next']], offsetX: 150, offsetY: 24, assertedEvents: [{ type: 'navigation' }] },
      { title: 'Принять условия Yahoo при необходимости', description: 'При первом входе принимает consent-экран Yahoo; при повторном запуске сразу продолжает работу.', type: 'waitForExpression', expression: yahooConsentExpression },
      { title: 'Дождаться почтового ящика', description: 'Подтверждает успешный вход появлением кнопки Compose.', type: 'waitForElement', selectors: [['[data-test-id="compose-button"]'], ['aria/Compose'], ['aria/Написать'], ['text/Compose']], visible: true },
      { title: 'Создать письмо', description: 'Открывает редактор нового письма Yahoo.', type: 'click', selectors: [['[data-test-id="compose-button"]'], ['aria/Compose'], ['aria/Написать'], ['text/Compose']], offsetX: 60, offsetY: 20 },
      { title: 'Дождаться редактора письма', description: 'Проверяет появление поля получателя.', type: 'waitForElement', selectors: [['[data-test-id="compose-to"]'], ['#message-to-field'], ['input[role="combobox"][aria-label*="To"]']], visible: true },
      { title: 'Указать получателя Gmail', description: 'Вводит адрес 10sydneyfc@gmail.com из context задания.', type: 'change', selectors: [['[data-test-id="compose-to"]'], ['#message-to-field'], ['input[role="combobox"][aria-label*="To"]']], value: '{{mail_to}}' },
      { title: 'Указать тему письма', description: 'Заполняет уникальную тему, чтобы письмо было легко найти после демонстрации.', type: 'change', selectors: [['[data-test-id="compose-subject"]'], ['input[data-test-id="compose-subject"]'], ['input[placeholder="Subject"]']], value: '{{mail_subject}}' },
      { title: 'Написать текст письма', description: 'Заполняет тело реального сообщения демонстрационным текстом.', type: 'change', selectors: [['[data-test-id="rte"]'], ['div[contenteditable="true"][role="textbox"]'], ['aria/Message body']], value: '{{mail_body}}' },
      { title: 'Отправить реальное письмо', description: 'Нажимает Send; этот шаг создаёт внешнее действие и доставку в Gmail.', type: 'click', selectors: [['[data-test-id="compose-send-button"]'], ['button[data-test-id="compose-send-button"]'], ['aria/Send']], offsetX: 45, offsetY: 20 },
      { title: 'Подтвердить отправку', description: 'Дожидается уведомления Yahoo об успешной отправке сообщения.', type: 'waitForElement', selectors: [['[data-test-id="toast"]'], ['[role="status"]'], ['text/Message sent'], ['text/Письмо отправлено']], visible: true }
    ]
  };
}

function yandexSearchReplay() {
  return {
    title: 'Этап 3 · Поиск в Яндексе и переход по первой ссылке',
    timeout: 12000,
    steps: [
      { title: 'Настроить окно Chromium', description: 'Устанавливает размер окна для наглядного показа поиска.', type: 'setViewport', width: 1400, height: 860, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { title: 'Открыть Яндекс', description: 'Переходит на главную страницу поисковой системы.', type: 'navigate', url: 'https://ya.ru/' },
      { title: 'Дождаться поисковой строки', description: 'Проверяет готовность формы поиска.', type: 'waitForElement', selectors: [['#text'], ['input[name="text"]'], ['aria/Запрос']], visible: true },
      { title: 'Выбрать поисковую строку', description: 'Устанавливает фокус в поле запроса.', type: 'click', selectors: [['#text'], ['input[name="text"]'], ['aria/Запрос']], offsetX: 240, offsetY: 22 },
      { title: 'Ввести поисковый запрос', description: 'Вводит демонстрационный текст из context.', type: 'change', selectors: [['#text'], ['input[name="text"]'], ['aria/Запрос']], value: '{{search_query}}' },
      { title: 'Запустить поиск', description: 'Нажимает кнопку поиска и открывает страницу результатов.', type: 'click', selectors: [['.search3__button'], ['button[aria-label="Найти"]'], ['aria/Найти']], offsetX: 35, offsetY: 22, assertedEvents: [{ type: 'navigation' }] },
      { title: 'Дождаться результатов', description: 'Ожидает появления первого органического результата.', type: 'waitForElement', selectors: [['#search-result'], ['.serp-list'], ['.Organic']], visible: true },
      { title: 'Найти первую ссылку', description: 'Проверяет наличие кликабельного заголовка первого органического результата.', type: 'waitForElement', selectors: [['.Organic .OrganicTitle-Link'], ['#search-result > li a.Link'], ['li.serp-item a[href]']], visible: true },
      { title: 'Открыть первый результат', description: 'Переходит по первой органической ссылке из результатов поиска.', type: 'click', selectors: [['.Organic .OrganicTitle-Link'], ['#search-result > li a.Link'], ['li.serp-item a[href]']], offsetX: 120, offsetY: 18 },
      { title: 'Дождаться целевой страницы', description: 'Ожидает завершения навигации после клика по результату.', type: 'waitForExpression', expression: "location.hostname !== 'ya.ru' && !location.hostname.endsWith('.yandex.ru')" }
    ]
  };
}

const stepLabels = {
  check_ip: ['Проверить IP-адрес', 'Сравнивает текущий IP с ожидаемым адресом рабочей машины.'],
  find_files: ['Найти файлы отчёта', 'Ищет входные файлы и сохраняет найденный список в context.found_files.'],
  launch_browser: ['Запустить браузер', 'Подготавливает Chromium для работы с внешним порталом.'],
  navigate: ['Открыть портал', 'Переходит на страницу, указанную в параметрах шага.'],
  auth_ecp: ['Авторизоваться по ЭЦП', 'Проверяет доступность плагина и выполняет авторизацию электронной подписью.'],
  upload_files: ['Загрузить файлы', 'Передаёт найденные файлы порталу и сохраняет результат загрузки в context.'],
  validate_report: ['Проверить отчёт', 'Выполняет бизнес-проверку отчёта перед отправкой.'],
  submit_if_valid: ['Отправить отчёт', 'Отправляет отчёт только после успешной проверки.'],
  download_files: ['Скачать квитанцию', 'Сохраняет квитанцию и добавляет файл в result.artifacts.'],
  move_files: ['Переместить обработанные файлы', 'Переносит исходные файлы в каталог обработанных документов.'],
  setViewport: ['Настроить окно Chromium', 'Устанавливает размер окна браузера для воспроизводимого запуска.']
};

function withStepMetadata(steps) {
  return steps.map((step, index) => {
    const [defaultTitle, defaultDescription] = stepLabels[step.action || step.type]
      || [`Шаг ${index + 1}`, 'Выполняет очередное действие демонстрационного сценария.'];
    return {
      ...step,
      title: step.title || defaultTitle,
      description: step.description || defaultDescription
    };
  });
}

function enrichScenarioSteps(scenario) {
  return {
    ...scenario,
    payload: {
      ...scenario.payload,
      script: {
        ...scenario.payload.script,
        steps: withStepMetadata(scenario.payload.script.steps)
      }
    }
  };
}

const demoScenarioDefinitions = [
  {
    id: 'browser-mail-replay',
    number: 'S3',
    title: 'Yahoo отправляет письмо',
    talkTime: '6 мин',
    runtime: '≈ 15–40 сек',
    result: 'REAL BROWSER',
    tone: 'success',
    summary: 'Chromium входит в seeergo@yahoo.com и отправляет реальное письмо на 10sydneyfc@gmail.com.',
    points: [
      '19 нативных шагов Puppeteer Replay работают с реальным Yahoo Mail',
      'Пароль берётся только из YAHOO_MAIL_PASSWORD и не хранится в сценарии',
      'Yahoo подтверждает отправку, итоговый экран сохраняется в result.artifacts'
    ],
    payload: {
      priority: 5,
      timeout_ms: 120000,
      retry_policy: { max_attempts: 1, backoff_ms: 500 },
      context: {
        mail_to: '10sydneyfc@gmail.com',
        mail_subject: stage3Subject,
        mail_body: 'Это реальное демонстрационное письмо отправлено из seeergo@yahoo.com сценарием Puppeteer Replay через Фабрику сценариев.'
      },
      script: browserMailReplay()
    }
  },
  {
    id: 'yandex-search-replay',
    number: 'S3B',
    title: 'Поиск в Яндексе',
    talkTime: '2 мин',
    runtime: '≈ 5–10 сек',
    result: 'REAL BROWSER',
    tone: 'success',
    summary: 'Chromium открывает Яндекс, вводит запрос и переходит по первому органическому результату.',
    points: [
      'Поисковый текст передаётся через context.search_query',
      'Ожидания отделены от кликов и делают сценарий понятным',
      'Последний шаг подтверждает переход с домена Яндекса'
    ],
    payload: {
      priority: 6,
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, backoff_ms: 500 },
      context: { search_query: yandexQuery },
      script: yandexSearchReplay()
    }
  },
  {
    id: 'happy-path',
    number: '01',
    title: 'Отчёт отправлен',
    talkTime: '4 мин',
    runtime: '≈ 5 сек',
    result: 'УСПЕШНО',
    tone: 'success',
    summary: 'Полный путь отчёта: от проверки сети до переноса файлов в архив.',
    points: [
      'Шаги выполняются строго по порядку',
      'Скачанная квитанция появляется в result.artifacts',
      'Прогресс и журнал обновляются во время запуска'
    ],
    payload: {
      priority: 10,
      timeout_ms: 15000,
      retry_policy: { max_attempts: 2, backoff_ms: 500 },
      script: {
        context: {
          current_ip: '192.168.1.10',
          root_dir: '/demo/incoming',
          loaded_dir: '/demo/loaded',
          receipt_dir: '/demo/downloads',
          prefixes: ['FNS', 'SFR', 'ROSSTAT']
        },
        default_step_timeout_ms: 1500,
        steps: [
          { id: 'network', action: 'check_ip', params: { expected_ip: '192.168.1.10' }, duration_ms: 350 },
          { id: 'files', action: 'find_files', params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}', files: ['FNS_2026_Q2.xml', 'SFR_2026_Q2.xml'] }, duration_ms: 450 },
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 450 },
          { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 450 },
          { id: 'identity', action: 'auth_ecp', params: { plugin_running: true }, duration_ms: 600 },
          { id: 'upload', action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 650 },
          { id: 'validate', action: 'validate_report', params: { valid: true }, duration_ms: 500 },
          { id: 'submit', action: 'submit_if_valid', params: {}, duration_ms: 450 },
          receiptDownloadStep(320),
          { id: 'archive', action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 350 }
        ]
      }
    }
  },
  {
    id: 'file-not-found',
    number: '02',
    title: 'Файл не найден',
    talkTime: '2 мин',
    runtime: '≈ 2 сек',
    result: 'ОШИБКА',
    tone: 'error',
    summary: 'Портал готов к работе, но цепочка останавливается при поиске отчётов.',
    points: [
      'Ошибка имеет стабильный код FILE_NOT_FOUND',
      'Четыре подготовительных шага уже завершены',
      'Загрузка, отправка и скачивание квитанции ожидают'
    ],
    payload: {
      priority: 20,
      timeout_ms: 5000,
      retry_policy: { max_attempts: 1, backoff_ms: 200 },
      script: {
        context: {
          current_ip: '192.168.1.10',
          root_dir: '/demo/empty',
          loaded_dir: '/demo/loaded',
          receipt_dir: '/demo/downloads',
          prefixes: ['FNS']
        },
        default_step_timeout_ms: 1200,
        steps: [
          { id: 'network', action: 'check_ip', params: { expected_ip: '192.168.1.10' }, duration_ms: 220 },
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 250 },
          { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 250 },
          { id: 'identity', action: 'auth_ecp', params: { plugin_running: true }, duration_ms: 350 },
          { id: 'files', action: 'find_files', params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}', files: [] }, duration_ms: 450 },
          { id: 'upload', action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 300 },
          { id: 'validate', action: 'validate_report', params: { valid: true }, duration_ms: 250 },
          { id: 'submit', action: 'submit_if_valid', params: {}, duration_ms: 220 },
          receiptDownloadStep(200),
          { id: 'archive', action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 200 }
        ]
      }
    }
  },
  {
    id: 'retry',
    number: '03',
    title: 'Повтор после сбоя',
    talkTime: '3 мин',
    runtime: '≈ 4 сек',
    result: '2-Я ПОПЫТКА',
    tone: 'retry',
    summary: 'Полная цепочка повторяется после временного сбоя плагина ЭЦП.',
    points: [
      'Сбой возникает после подготовки файлов и портала',
      'Очередь выдерживает backoff 700 мс',
      'Вторая попытка успешно проходит все десять шагов'
    ],
    payload: {
      priority: 30,
      timeout_ms: 8000,
      retry_policy: { max_attempts: 2, backoff_ms: 700 },
      script: {
        context: {
          current_ip: '192.168.1.10',
          root_dir: '/demo/incoming',
          loaded_dir: '/demo/loaded',
          receipt_dir: '/demo/downloads',
          prefixes: ['FNS', 'SFR']
        },
        default_step_timeout_ms: 1200,
        steps: [
          { id: 'network', action: 'check_ip', params: { expected_ip: '192.168.1.10' }, duration_ms: 180 },
          { id: 'files', action: 'find_files', params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}', files: ['FNS_2026_Q2.xml', 'SFR_2026_Q2.xml'] }, duration_ms: 250 },
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 220 },
          { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 220 },
          { id: 'identity', action: 'auth_ecp', params: { fail_attempts: 1 }, duration_ms: 350 },
          { id: 'upload', action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 300 },
          { id: 'validate', action: 'validate_report', params: { valid: true }, duration_ms: 220 },
          { id: 'submit', action: 'submit_if_valid', params: {}, duration_ms: 220 },
          receiptDownloadStep(200),
          { id: 'archive', action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 180 }
        ]
      }
    }
  },
  {
    id: 'timeout',
    number: '04',
    title: 'Контроль тайм-аута',
    talkTime: '2 мин',
    runtime: '≈ 2 сек',
    result: 'ТАЙМ-АУТ',
    tone: 'timeout',
    summary: 'Портал открыт, но зависшая авторизация по ЭЦП прерывается по лимиту.',
    points: [
      'Авторизация ограничена собственными 300 мс',
      'Зависший исполнитель не блокирует очередь',
      'Следующие бизнес-шаги остаются в ожидании'
    ],
    payload: {
      priority: 40,
      timeout_ms: 5000,
      retry_policy: { max_attempts: 1, backoff_ms: 200 },
      script: {
        context: {
          current_ip: '192.168.1.10',
          root_dir: '/demo/incoming',
          loaded_dir: '/demo/loaded',
          receipt_dir: '/demo/downloads',
          prefixes: ['FNS', 'SFR']
        },
        default_step_timeout_ms: 1200,
        steps: [
          { id: 'network', action: 'check_ip', params: { expected_ip: '192.168.1.10' }, duration_ms: 180 },
          { id: 'files', action: 'find_files', params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}', files: ['FNS_2026_Q2.xml', 'SFR_2026_Q2.xml'] }, duration_ms: 250 },
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 220 },
          { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 220 },
          { id: 'identity', action: 'auth_ecp', params: { plugin_running: true }, timeout_ms: 300, duration_ms: 1400 },
          { id: 'upload', action: 'upload_files', params: { files: '{{found_files}}' }, duration_ms: 300 },
          { id: 'validate', action: 'validate_report', params: { valid: true }, duration_ms: 220 },
          { id: 'submit', action: 'submit_if_valid', params: {}, duration_ms: 220 },
          receiptDownloadStep(200),
          { id: 'archive', action: 'move_files', params: { files: '{{found_files}}', destination: '{{loaded_dir}}' }, duration_ms: 180 }
        ]
      }
    }
  }
];

export const demoScenarios = demoScenarioDefinitions.map(enrichScenarioSteps);

export const blankScenario = {
  priority: 100,
  timeout_ms: 30000,
  retry_policy: { max_attempts: 1, backoff_ms: 500 },
  context: { target_url: 'https://example.org' },
  script: {
    title: 'Новый сценарий Chrome Recorder',
    timeout: 10000,
    steps: withStepMetadata([
      { type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { title: 'Открыть целевой адрес', description: 'Переходит на URL из context.target_url.', type: 'navigate', url: '{{target_url}}' }
    ])
  }
};
