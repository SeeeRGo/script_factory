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
      'Результат шага попадает в общий контекст',
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
    runtime: '≈ 1 сек',
    result: 'ОШИБКА',
    tone: 'error',
    summary: 'Предсказуемая остановка на поиске файла без запуска следующих шагов.',
    points: [
      'Ошибка имеет стабильный код FILE_NOT_FOUND',
      'Виден точный шаг и параметры сбоя',
      'Оставшиеся действия не выполняются'
    ],
    payload: {
      priority: 20,
      timeout_ms: 5000,
      retry_policy: { max_attempts: 1, backoff_ms: 200 },
      script: {
        context: { current_ip: '192.168.1.10', root_dir: '/demo/empty', prefixes: ['FNS'] },
        steps: [
          { id: 'network', action: 'check_ip', params: { expected_ip: '192.168.1.10' }, duration_ms: 350 },
          { id: 'files', action: 'find_files', params: { directory: '{{root_dir}}', prefixes: '{{prefixes}}', files: [] }, duration_ms: 450 },
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 300 }
        ]
      }
    }
  },
  {
    id: 'retry',
    number: '03',
    title: 'Повтор после сбоя',
    talkTime: '3 мин',
    runtime: '≈ 3 сек',
    result: '2-Я ПОПЫТКА',
    tone: 'retry',
    summary: 'Плагин ЭЦП недоступен один раз, после паузы задание восстанавливается.',
    points: [
      'Первая попытка завершается retryable-ошибкой',
      'Очередь выдерживает backoff 700 мс',
      'Повторный запуск успешно проходит всю цепочку'
    ],
    payload: {
      priority: 30,
      timeout_ms: 8000,
      retry_policy: { max_attempts: 2, backoff_ms: 700 },
      script: {
        steps: [
          { id: 'browser', action: 'launch_browser', params: { browser: 'chromium' }, duration_ms: 350 },
          { id: 'identity', action: 'auth_ecp', params: { fail_attempts: 1 }, duration_ms: 450 },
          { id: 'portal', action: 'navigate', params: { url: 'https://online.sbis.ru' }, duration_ms: 350 }
        ]
      }
    }
  },
  {
    id: 'timeout',
    number: '04',
    title: 'Контроль тайм-аута',
    talkTime: '2 мин',
    runtime: '< 1 сек',
    result: 'ТАЙМ-АУТ',
    tone: 'timeout',
    summary: 'Долгий шаг прерывается по собственному лимиту и возвращает понятную ошибку.',
    points: [
      'Лимит задаётся отдельно для каждого шага',
      'Зависший исполнитель не блокирует очередь',
      'Причина и длительность остаются в журнале'
    ],
    payload: {
      priority: 40,
      timeout_ms: 3000,
      retry_policy: { max_attempts: 1, backoff_ms: 200 },
      script: {
        steps: [
          { id: 'slow-operation', action: 'noop', timeout_ms: 300, duration_ms: 1400 }
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
