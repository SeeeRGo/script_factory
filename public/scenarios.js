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

export const demoScenarios = [
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
  timeout_ms: 10000,
  retry_policy: { max_attempts: 1, backoff_ms: 500 },
  script: {
    context: {},
    default_step_timeout_ms: 3000,
    steps: [
      {
        id: 'step-1',
        action: 'noop',
        params: {},
        duration_ms: 500
      }
    ]
  }
};
