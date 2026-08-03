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

function browserMailReplay() {
  return {
    title: 'Этап 3 · Вход в почту и отправка письма',
    timeout: 10000,
    steps: [
      { type: 'setViewport', width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { type: 'navigate', url: '{{demo_mail_url}}' },
      { type: 'waitForElement', selectors: [['#mail-login-form'], ['aria/Вход в почту']], visible: true },
      { type: 'click', selectors: [['#mail-login'], ['aria/Логин']], offsetX: 110, offsetY: 18 },
      { type: 'change', selectors: [['#mail-login'], ['aria/Логин']], value: '{{mail_login}}' },
      { type: 'click', selectors: [['#mail-password'], ['aria/Пароль']], offsetX: 110, offsetY: 18 },
      { type: 'change', selectors: [['#mail-password'], ['aria/Пароль']], value: '{{mail_password}}' },
      { type: 'click', selectors: [['#mail-login-submit'], ['aria/Войти']], offsetX: 150, offsetY: 20 },
      { type: 'waitForElement', selectors: [['#mail-compose'], ['aria/Написать']], visible: true },
      { type: 'click', selectors: [['#mail-compose'], ['aria/Написать']], offsetX: 75, offsetY: 20 },
      { type: 'waitForElement', selectors: [['#mail-compose-panel:not([hidden])']], visible: true },
      { type: 'change', selectors: [['#mail-to'], ['aria/Кому']], value: '{{mail_to}}' },
      { type: 'change', selectors: [['#mail-subject'], ['aria/Тема']], value: '{{mail_subject}}' },
      { type: 'change', selectors: [['#mail-body'], ['aria/Сообщение']], value: '{{mail_body}}' },
      { type: 'click', selectors: [['#mail-send'], ['aria/Отправить']], offsetX: 55, offsetY: 20 },
      { type: 'waitForElement', selectors: [['#mail-send-success:not([hidden])'], ['text/Письмо отправлено']], visible: true },
      { type: 'click', selectors: [['#mail-folder-sent'], ['text/Отправленные']], offsetX: 80, offsetY: 18 },
      {
        type: 'waitForElement',
        selectors: [[`.sent-message[data-subject="${stage3Subject}"]`]],
        visible: true,
        attributes: { 'data-subject': stage3Subject }
      }
    ]
  };
}

export const demoScenarios = [
  {
    id: 'browser-mail-replay',
    number: 'S3',
    title: 'Письмо отправляет браузер',
    talkTime: '6 мин',
    runtime: '≈ 5–10 сек',
    result: 'REAL BROWSER',
    tone: 'success',
    summary: 'Chrome Recorder JSON входит в почту, создаёт письмо и подтверждает его появление в отправленных.',
    points: [
      '18 нативных шагов Puppeteer Replay без специальных action-обработчиков',
      'Логин, ожидания, ввод данных и проверка результата выполняются Chromium',
      'Итоговый скриншот сохраняется в result.artifacts'
    ],
    payload: {
      priority: 5,
      timeout_ms: 45000,
      retry_policy: { max_attempts: 1, backoff_ms: 500 },
      context: {
        mail_to: 'demo.recipient@example.test',
        mail_subject: stage3Subject,
        mail_body: 'Письмо создано и отправлено реальным браузером из Puppeteer Replay JSON. Ручное вмешательство не потребовалось.'
      },
      script: browserMailReplay()
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

export const blankScenario = {
  priority: 100,
  timeout_ms: 30000,
  retry_policy: { max_attempts: 1, backoff_ms: 500 },
  context: { target_url: 'https://example.org' },
  script: {
    title: 'Новый сценарий Chrome Recorder',
    timeout: 10000,
    steps: [
      { type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      { type: 'navigate', url: '{{target_url}}' }
    ]
  }
};
