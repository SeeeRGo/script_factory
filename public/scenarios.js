// Executable demos use the same JSON workflow runtime as SBIS.
export const demoScenarios = [
  {
    "id": "browser-mail-replay",
    "number": "S3",
    "title": "Yahoo отправляет письмо",
    "talkTime": "6 мин",
    "runtime": "≈ 15–40 сек",
    "result": "REAL BROWSER",
    "tone": "success",
    "summary": "Chromium входит в seeergo@yahoo.com и отправляет реальное письмо на 10sydneyfc@gmail.com.",
    "points": [
      "Шаги Recorder выполняются внутри универсального browser_steps",
      "Пароль берётся только из YAHOO_MAIL_PASSWORD и не хранится в сценарии",
      "Yahoo подтверждает отправку, итоговый экран сохраняется в result.artifacts"
    ],
    "payload": {
      "priority": 5,
      "timeout_ms": 120000,
      "retry_policy": {
        "max_attempts": 1,
        "backoff_ms": 500
      },
      "context": {
        "mail_to": "10sydneyfc@gmail.com",
        "mail_subject": "Автоматизация Stage 3 · 16.11.2026, 10:28:52",
        "mail_body": "Это реальное демонстрационное письмо отправлено из seeergo@yahoo.com сценарием Puppeteer Replay через Фабрику сценариев."
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "browser_launch",
            "title": "Запустить браузер",
            "description": "Запустить браузер",
            "params": {}
          },
          {
            "action": "browser_steps",
            "title": "Настроить окно Chromium",
            "description": "Настроить окно Chromium",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Настроить окно Chromium",
                  "description": "Устанавливает презентационный размер окна перед открытием Yahoo.",
                  "type": "setViewport",
                  "width": 1400,
                  "height": 860,
                  "deviceScaleFactor": 1,
                  "isMobile": false,
                  "hasTouch": false,
                  "isLandscape": false
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Открыть Yahoo",
            "description": "Открыть Yahoo",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Открыть Yahoo",
                  "description": "Переходит на актуальную страницу входа Yahoo Mail.",
                  "type": "navigate",
                  "url": "{{yahoo_mail_url}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться формы входа",
            "description": "Дождаться формы входа",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Дождаться формы входа",
                  "description": "Проверяет, что Yahoo показал поле имени пользователя.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "#username"
                    ],
                    [
                      "input[name=\"username\"]"
                    ],
                    [
                      "aria/Username, email, or mobile"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Выбрать поле логина",
            "description": "Выбрать поле логина",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Выбрать поле логина",
                  "description": "Устанавливает фокус в поле учётной записи Yahoo.",
                  "type": "click",
                  "selectors": [
                    [
                      "#username"
                    ],
                    [
                      "input[name=\"username\"]"
                    ]
                  ],
                  "offsetX": 150,
                  "offsetY": 24
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Ввести адрес Yahoo",
            "description": "Ввести адрес Yahoo",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Ввести адрес Yahoo",
                  "description": "Вводит адрес отправителя из защищённой конфигурации сервера.",
                  "type": "change",
                  "selectors": [
                    [
                      "#username"
                    ],
                    [
                      "input[name=\"username\"]"
                    ]
                  ],
                  "value": "{{yahoo_login}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Перейти к паролю",
            "description": "Перейти к паролю",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Перейти к паролю",
                  "description": "Нажимает Next и открывает второй этап авторизации Yahoo.",
                  "type": "click",
                  "selectors": [
                    [
                      "button[name=\"signin\"]"
                    ],
                    [
                      "button[type=\"submit\"]"
                    ],
                    [
                      "aria/Next"
                    ]
                  ],
                  "offsetX": 150,
                  "offsetY": 24,
                  "assertedEvents": [
                    {
                      "type": "navigation"
                    }
                  ]
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться поля пароля",
            "description": "Дождаться поля пароля",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Дождаться поля пароля",
                  "description": "Ожидает пароль или завершает шаг ошибкой при CAPTCHA/дополнительной проверке.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "#login-passwd"
                    ],
                    [
                      "input[name=\"password\"]"
                    ],
                    [
                      "input[type=\"password\"]"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Выбрать поле пароля",
            "description": "Выбрать поле пароля",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Выбрать поле пароля",
                  "description": "Устанавливает фокус в поле пароля Yahoo.",
                  "type": "click",
                  "selectors": [
                    [
                      "#login-passwd"
                    ],
                    [
                      "input[name=\"password\"]"
                    ],
                    [
                      "input[type=\"password\"]"
                    ]
                  ],
                  "offsetX": 150,
                  "offsetY": 24
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Ввести пароль Yahoo",
            "description": "Ввести пароль Yahoo",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Ввести пароль Yahoo",
                  "description": "Берёт пароль из YAHOO_MAIL_PASSWORD; значение скрывается в прогрессе и логах.",
                  "type": "change",
                  "selectors": [
                    [
                      "#login-passwd"
                    ],
                    [
                      "input[name=\"password\"]"
                    ],
                    [
                      "input[type=\"password\"]"
                    ]
                  ],
                  "value": "{{yahoo_password}}"
                }
              ]
            },
            "private": true
          },
          {
            "action": "browser_steps",
            "title": "Войти в почту",
            "description": "Войти в почту",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Войти в почту",
                  "description": "Отправляет форму пароля и переходит в Yahoo Mail.",
                  "type": "click",
                  "selectors": [
                    [
                      "button[name=\"verifyPassword\"]"
                    ],
                    [
                      "#login-signin"
                    ],
                    [
                      "button[type=\"submit\"]"
                    ],
                    [
                      "aria/Next"
                    ]
                  ],
                  "offsetX": 150,
                  "offsetY": 24,
                  "assertedEvents": [
                    {
                      "type": "navigation"
                    }
                  ]
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Обработать условия Yahoo при необходимости",
            "description": "Обработать условия Yahoo при необходимости",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Обработать условия Yahoo при необходимости",
                  "description": "Проходит guce- и mailbox-consent Yahoo; при повторном запуске сразу продолжает работу.",
                  "type": "waitForExpression",
                  "expression": "(() => {\n  const host = location.hostname;\n  if (host !== 'guce.yahoo.com' && host !== 'consent.yahoo.com') return true;\n  const text = (element) => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();\n  const visible = (element) => {\n    const rect = element.getBoundingClientRect();\n    return rect.width > 0 && rect.height > 0;\n  };\n  if (host === 'guce.yahoo.com') {\n    const buttons = [...document.querySelectorAll('button, input[type=\"submit\"]')];\n    const accept = buttons.find((button) => button.name === 'agree'\n      || button.value === 'agree'\n      || button.classList.contains('accept-all')\n      || /^(accept all|alles accepteren|принять все|alle akzeptieren|tout accepter|aceptar todo|accetta tutto)$/i.test(text(button)));\n    if (!accept) return false;\n    if (!globalThis.__scriptFactoryYahooGuceClicked) {\n      globalThis.__scriptFactoryYahooGuceClicked = true;\n      accept.click();\n    }\n    return false;\n  }\n  const radios = [...document.querySelectorAll('input[type=\"radio\"]')];\n  const groups = [...new Set(radios.map((radio) => radio.name).filter(Boolean))];\n  let changed = false;\n  for (const name of groups) {\n    const choices = radios.filter((radio) => radio.name === name);\n    if (choices.some((radio) => radio.checked)) continue;\n    const reject = choices.find((radio) => /reject|deny|weigeren|refuse|false|no/i.test(\n      [radio.value, radio.id, radio.getAttribute('aria-label'), radio.labels?.[0]?.innerText].filter(Boolean).join(' ')\n    )) || choices[0];\n    reject.click();\n    changed = true;\n  }\n  const rejectLabels = [...document.querySelectorAll('label')].filter((label) => {\n    const control = label.control || label.querySelector('input[type=\"radio\"], [role=\"radio\"]');\n    return control && !control.checked && control.getAttribute?.('aria-checked') !== 'true'\n      && /reject|deny|weigeren|refuse|отклон/i.test(text(label));\n  });\n  for (const label of rejectLabels) {\n    label.click();\n    changed = true;\n  }\n  const ariaRejects = [...document.querySelectorAll('[role=\"radio\"][aria-checked=\"false\"]')]\n    .filter((radio) => /reject|deny|weigeren|refuse|отклон/i.test(text(radio)));\n  for (const radio of ariaRejects) {\n    radio.click();\n    changed = true;\n  }\n  if (changed) return false;\n  window.scrollTo(0, document.documentElement.scrollHeight);\n  const buttons = [...document.querySelectorAll('button, input[type=\"submit\"]')]\n    .filter((button) => !button.disabled && visible(button));\n  const submit = buttons.find((button) => /doorgaan|opslaan|continue|save|confirm|bevestigen|done|gereed|submit/i.test(text(button)))\n    || buttons.find((button) => button.type === 'submit')\n    || buttons.at(-1);\n  if (!submit) return false;\n  const now = Date.now();\n  if (!globalThis.__scriptFactoryYahooConsentSubmitAt || now - globalThis.__scriptFactoryYahooConsentSubmitAt > 1000) {\n    globalThis.__scriptFactoryYahooConsentSubmitAt = now;\n    submit.click();\n  }\n  return false;\n})()"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Подготовить интерфейс Mail",
            "description": "Подготовить интерфейс Mail",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Подготовить интерфейс Mail",
                  "description": "Закрывает необязательный onboarding и распознаёт кнопку New message / Compose в текущем Yahoo UI.",
                  "type": "waitForExpression",
                  "expression": "(() => {\n  if (location.hostname !== 'mail.yahoo.com') return false;\n  const visible = (element) => {\n    const rect = element.getBoundingClientRect();\n    return rect.width > 0 && rect.height > 0;\n  };\n  const compose = document.querySelector('[data-test-id=\"compose-button\"], [aria-label*=\"New message\" i], [aria-label*=\"Compose\" i], [aria-label*=\"Написать\" i]')\n    || [...document.querySelectorAll('a, button')].find((element) => /^(new message|compose|написать|nieuw bericht)$/i.test((element.innerText || '').trim()));\n  const dialogs = [...document.querySelectorAll('[role=\"dialog\"], [aria-modal=\"true\"], [data-test-id*=\"modal\"]')]\n    .filter(visible);\n  if (!dialogs.length) return Boolean(compose && visible(compose));\n  const dialog = dialogs.at(-1);\n  const controls = [...dialog.querySelectorAll('button, a[role=\"button\"]')]\n    .filter((control) => !control.disabled && visible(control));\n  const label = (control) => (control.innerText || control.getAttribute('aria-label') || '').trim();\n  const action = controls.find((control) => /skip|maybe later|not now|continue|next|done|got it|finish|close|overslaan|later|doorgaan|volgende|gereed|sluiten|пропустить|позже|далее|готово|закрыть/i.test(label(control)))\n    || controls.find((control) => /close|dismiss/i.test(control.getAttribute('aria-label') || ''));\n  if (!action) return false;\n  const now = Date.now();\n  if (!globalThis.__scriptFactoryYahooOnboardingClickAt || now - globalThis.__scriptFactoryYahooOnboardingClickAt > 1000) {\n    globalThis.__scriptFactoryYahooOnboardingClickAt = now;\n    action.click();\n  }\n  return false;\n})()"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться почтового ящика",
            "description": "Дождаться почтового ящика",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Дождаться почтового ящика",
                  "description": "Подтверждает успешный вход появлением кнопки New message / Compose.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-button\"]"
                    ],
                    [
                      "[aria-label*=\"New message\"]"
                    ],
                    [
                      "aria/New message"
                    ],
                    [
                      "text/New message"
                    ],
                    [
                      "aria/Compose"
                    ],
                    [
                      "aria/Написать"
                    ],
                    [
                      "text/Compose"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Создать письмо",
            "description": "Создать письмо",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Создать письмо",
                  "description": "Открывает редактор нового письма в классическом или новом Yahoo UI.",
                  "type": "click",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-button\"]"
                    ],
                    [
                      "[aria-label*=\"New message\"]"
                    ],
                    [
                      "aria/New message"
                    ],
                    [
                      "text/New message"
                    ],
                    [
                      "aria/Compose"
                    ],
                    [
                      "aria/Написать"
                    ],
                    [
                      "text/Compose"
                    ]
                  ],
                  "offsetX": 60,
                  "offsetY": 20
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться редактора письма",
            "description": "Дождаться редактора письма",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Дождаться редактора письма",
                  "description": "Проверяет появление поля получателя.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-to\"]"
                    ],
                    [
                      "#message-to-field"
                    ],
                    [
                      "input[role=\"combobox\"][aria-label*=\"To\"]"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Указать получателя Gmail",
            "description": "Указать получателя Gmail",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Указать получателя Gmail",
                  "description": "Вводит адрес 10sydneyfc@gmail.com из context задания.",
                  "type": "change",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-to\"]"
                    ],
                    [
                      "#message-to-field"
                    ],
                    [
                      "input[role=\"combobox\"][aria-label*=\"To\"]"
                    ]
                  ],
                  "value": "{{mail_to}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Указать тему письма",
            "description": "Указать тему письма",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Указать тему письма",
                  "description": "Заполняет уникальную тему, чтобы письмо было легко найти после демонстрации.",
                  "type": "change",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-subject\"]"
                    ],
                    [
                      "input[data-test-id=\"compose-subject\"]"
                    ],
                    [
                      "input[placeholder=\"Subject\"]"
                    ]
                  ],
                  "value": "{{mail_subject}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Написать текст письма",
            "description": "Написать текст письма",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Написать текст письма",
                  "description": "Заполняет тело реального сообщения демонстрационным текстом.",
                  "type": "change",
                  "selectors": [
                    [
                      "[data-test-id=\"rte\"]"
                    ],
                    [
                      "div[contenteditable=\"true\"][role=\"textbox\"]"
                    ],
                    [
                      "aria/Message body"
                    ]
                  ],
                  "value": "{{mail_body}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Отправить реальное письмо",
            "description": "Отправить реальное письмо",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Отправить реальное письмо",
                  "description": "Нажимает Send; этот шаг создаёт внешнее действие и доставку в Gmail.",
                  "type": "click",
                  "selectors": [
                    [
                      "[data-test-id=\"compose-send-button\"]"
                    ],
                    [
                      "button[data-test-id=\"compose-send-button\"]"
                    ],
                    [
                      "aria/Send"
                    ]
                  ],
                  "offsetX": 45,
                  "offsetY": 20
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Подтвердить отправку",
            "description": "Подтвердить отправку",
            "params": {
              "timeout_ms": 30000,
              "steps": [
                {
                  "title": "Подтвердить отправку",
                  "description": "Дожидается уведомления Yahoo об успешной отправке сообщения.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "[data-test-id=\"toast\"]"
                    ],
                    [
                      "[role=\"status\"]"
                    ],
                    [
                      "text/Message sent"
                    ],
                    [
                      "text/Письмо отправлено"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_screenshot",
            "title": "Сохранить итоговый экран",
            "description": "Сохраняет итоговый экран браузера как артефакт workflow.",
            "params": {
              "filename": "workflow-final.png"
            }
          }
        ],
        "output": {},
        "title": "Этап 3 · Реальная отправка Yahoo → Gmail"
      }
    }
  },
  {
    "id": "yandex-search-replay",
    "number": "S3B",
    "title": "Поиск в Яндексе",
    "talkTime": "2 мин",
    "runtime": "≈ 5–10 сек · CAPTCHA до 2 мин",
    "result": "REAL BROWSER",
    "tone": "success",
    "summary": "Chromium открывает Яндекс, вводит запрос и переходит по первому органическому результату.",
    "points": [
      "Поисковый текст передаётся через context.search_query",
      "Ожидания отделены от кликов и делают сценарий понятным",
      "При CAPTCHA снимок ошибки помогает определить необходимость ручной проверки"
    ],
    "payload": {
      "priority": 6,
      "timeout_ms": 180000,
      "retry_policy": {
        "max_attempts": 1,
        "backoff_ms": 500
      },
      "context": {
        "search_query": "официальная документация Node.js"
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "browser_launch",
            "title": "Запустить браузер",
            "description": "Запустить браузер",
            "params": {}
          },
          {
            "action": "browser_steps",
            "title": "Настроить окно Chromium",
            "description": "Настроить окно Chromium",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Настроить окно Chromium",
                  "description": "Устанавливает размер окна для наглядного показа поиска.",
                  "type": "setViewport",
                  "width": 1400,
                  "height": 860,
                  "deviceScaleFactor": 1,
                  "isMobile": false,
                  "hasTouch": false,
                  "isLandscape": false
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Открыть Яндекс",
            "description": "Открыть Яндекс",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Открыть Яндекс",
                  "description": "Переходит на главную страницу поисковой системы.",
                  "type": "navigate",
                  "url": "https://ya.ru/"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться поисковой строки",
            "description": "Дождаться поисковой строки",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Дождаться поисковой строки",
                  "description": "Проверяет готовность формы поиска.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "#text"
                    ],
                    [
                      "input[name=\"text\"]"
                    ],
                    [
                      "aria/Запрос"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Выбрать поисковую строку",
            "description": "Выбрать поисковую строку",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Выбрать поисковую строку",
                  "description": "Устанавливает фокус в поле запроса.",
                  "type": "click",
                  "selectors": [
                    [
                      "#text"
                    ],
                    [
                      "input[name=\"text\"]"
                    ],
                    [
                      "aria/Запрос"
                    ]
                  ],
                  "offsetX": 240,
                  "offsetY": 22
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Ввести поисковый запрос",
            "description": "Ввести поисковый запрос",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Ввести поисковый запрос",
                  "description": "Вводит демонстрационный текст из context.",
                  "type": "change",
                  "selectors": [
                    [
                      "#text"
                    ],
                    [
                      "input[name=\"text\"]"
                    ],
                    [
                      "aria/Запрос"
                    ]
                  ],
                  "value": "{{search_query}}"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Запустить поиск",
            "description": "Запустить поиск",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Запустить поиск",
                  "description": "Нажимает Enter в поисковой строке и не зависит от варианта кнопки «Найти» или «Алиса AI».",
                  "type": "keyDown",
                  "key": "Enter"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Отпустить клавишу Enter",
            "description": "Отпустить клавишу Enter",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Отпустить клавишу Enter",
                  "description": "Завершает клавиатурное действие после отправки поисковой формы.",
                  "type": "keyUp",
                  "key": "Enter"
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться результатов",
            "description": "Дождаться результатов",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Дождаться результатов",
                  "description": "Ожидает появления первого органического результата.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      "#search-result"
                    ],
                    [
                      ".serp-list"
                    ],
                    [
                      ".Organic"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Найти первую ссылку",
            "description": "Найти первую ссылку",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Найти первую ссылку",
                  "description": "Проверяет наличие кликабельного заголовка первого органического результата.",
                  "type": "waitForElement",
                  "selectors": [
                    [
                      ".Organic .OrganicTitle-Link"
                    ],
                    [
                      "#search-result > li a.Link"
                    ],
                    [
                      "li.serp-item a[href]"
                    ]
                  ],
                  "visible": true
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Открыть первый результат",
            "description": "Открыть первый результат",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Открыть первый результат",
                  "description": "Переходит по первой органической ссылке из результатов поиска.",
                  "type": "click",
                  "selectors": [
                    [
                      ".Organic .OrganicTitle-Link"
                    ],
                    [
                      "#search-result > li a.Link"
                    ],
                    [
                      "li.serp-item a[href]"
                    ]
                  ],
                  "offsetX": 120,
                  "offsetY": 18
                }
              ]
            }
          },
          {
            "action": "browser_steps",
            "title": "Дождаться целевой страницы",
            "description": "Дождаться целевой страницы",
            "params": {
              "timeout_ms": 12000,
              "steps": [
                {
                  "title": "Дождаться целевой страницы",
                  "description": "Ожидает завершения навигации после клика по результату.",
                  "type": "waitForExpression",
                  "expression": "location.hostname !== 'ya.ru' && !location.hostname.endsWith('.yandex.ru')"
                }
              ]
            }
          },
          {
            "action": "browser_screenshot",
            "title": "Сохранить итоговый экран",
            "description": "Сохраняет итоговый экран браузера как артефакт workflow.",
            "params": {
              "filename": "workflow-final.png"
            }
          }
        ],
        "output": {},
        "title": "Этап 3 · Поиск в Яндексе и переход по первой ссылке"
      }
    }
  },
  {
    "id": "download-save-open",
    "number": "S4F",
    "title": "Скачать файлы разных форматов",
    "talkTime": "1 мин",
    "runtime": "≈ 5–10 сек",
    "result": "REAL FILE",
    "tone": "success",
    "summary": "Исполнитель скачивает XML, JSON, CSV и TXT по HTTP, сохраняет их на УН, проверяет содержимое и открывает XML в Яндекс Браузере.",
    "points": [
      "Четыре файла физически записываются в каталог артефактов конкретного задания",
      "Размер и SHA-256 рассчитываются по фактически полученным данным",
      "Сохранённый документ открывается в Chromium и остаётся доступен в result.artifacts"
    ],
    "payload": {
      "priority": 8,
      "timeout_ms": 180000,
      "retry_policy": {
        "max_attempts": 2,
        "backoff_ms": 500
      },
      "context": {},
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "browser_launch",
            "title": "Запустить браузер",
            "description": "Запустить браузер",
            "params": {}
          },
          {
            "action": "browser_steps",
            "title": "Открыть локальную страницу сервиса",
            "description": "Открыть локальную страницу сервиса",
            "params": {
              "steps": [
                {
                  "type": "navigate",
                  "url": "{{service_base_url}}/demo/mail"
                }
              ]
            }
          },
          {
            "action": "set",
            "title": "Задать файлы учебного набора",
            "description": "Задать файлы учебного набора",
            "params": {
              "download_sources": [
                {
                  "filename": "stage4-report.xml",
                  "mime": "application/xml"
                },
                {
                  "filename": "stage4-result.json",
                  "mime": "application/json"
                },
                {
                  "filename": "stage4-register.csv",
                  "mime": "text/csv"
                },
                {
                  "filename": "stage4-log.txt",
                  "mime": "text/plain"
                }
              ]
            }
          },
          {
            "action": "for_each",
            "title": "Скачать файлы через браузер и сохранить",
            "description": "Загружает реальные байты с учебного HTTP-сервера и записывает артефакты.",
            "as": "source",
            "params": {
              "items": "{{download_sources}}"
            },
            "steps": [
              {
                "action": "browser_eval",
                "title": "Прочитать HTTP-ответ",
                "description": "Прочитать HTTP-ответ",
                "params": {
                  "expression": "(async()=>{ const r=await fetch(context.service_base_url+\"/demo/files/\"+context.source.filename); if(!r.ok)throw new Error(\"HTTP \"+r.status); return await r.text(); })()"
                },
                "save_as": "download_body"
              },
              {
                "action": "artifact_write",
                "title": "Сохранить скачанный файл",
                "description": "Сохранить скачанный файл",
                "params": {
                  "filename": "{{source.filename}}",
                  "text": "{{download_body}}",
                  "mime_type": "{{source.mime}}"
                }
              }
            ]
          },
          {
            "action": "files_list",
            "title": "Найти сохранённые файлы",
            "description": "Найти сохранённые файлы",
            "params": {
              "directory": "{{artifact_dir}}"
            },
            "save_as": "saved_files"
          },
          {
            "action": "compute",
            "title": "Выбрать документ для просмотра",
            "description": "Выбрать документ для просмотра",
            "params": {
              "expression": "context.saved_files.find(f=>f.filename===context.download_sources[0].filename)"
            },
            "save_as": "saved_file"
          },
          {
            "action": "file_read",
            "title": "Прочитать сохранённый документ",
            "description": "Прочитать сохранённый документ",
            "params": {
              "file": "{{saved_file}}"
            },
            "save_as": "file_content"
          },
          {
            "action": "compute",
            "title": "Получить адрес локального файла",
            "description": "Получить адрес локального файла",
            "params": {
              "expression": "(context.saved_file.path.startsWith(\"/\")?\"file://\":\"file:///\")+context.saved_file.path.replace(/\\\\/g,\"/\")"
            },
            "save_as": "opened_url"
          },
          {
            "action": "browser_steps",
            "title": "Открыть сохранённый документ",
            "description": "Открыть сохранённый документ",
            "params": {
              "steps": [
                {
                  "type": "navigate",
                  "url": "{{opened_url}}"
                }
              ]
            }
          },
          {
            "action": "browser_screenshot",
            "title": "Сохранить экран документа",
            "description": "Сохранить экран документа",
            "params": {
              "filename": "opened-document.png"
            }
          },
          {
            "action": "set",
            "title": "Завершить файловую демонстрацию",
            "description": "Завершить файловую демонстрацию",
            "params": {
              "state": "completed"
            }
          }
        ],
        "output": {
          "Rezult_1": {
            "state": "completed",
            "opened_url": "{{opened_url}}"
          }
        },
        "title": "Скачать, проверить и открыть учебные файлы"
      }
    }
  },
  {
    "id": "happy-path",
    "number": "01",
    "title": "Отчёт отправлен",
    "talkTime": "4 мин",
    "runtime": "≈ 5 сек",
    "result": "УСПЕШНО",
    "tone": "success",
    "summary": "Учебный JSON workflow: УСПЕШНО. Без входа в СБИС и отправки отчётности.",
    "points": [
      "Универсальные операции json-workflow",
      "Повторы определяются retry_policy",
      "Шаги и ошибки видны в журнале"
    ],
    "payload": {
      "priority": 10,
      "timeout_ms": 15000,
      "retry_policy": {
        "max_attempts": 2,
        "backoff_ms": 500
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "wait",
            "title": "Учебный процесс: этап 1",
            "description": "Учебный процесс: этап 1",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 2",
            "description": "Учебный процесс: этап 2",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 3",
            "description": "Учебный процесс: этап 3",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 4",
            "description": "Учебный процесс: этап 4",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 5",
            "description": "Учебный процесс: этап 5",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 6",
            "description": "Учебный процесс: этап 6",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 7",
            "description": "Учебный процесс: этап 7",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "wait",
            "title": "Учебный процесс: этап 8",
            "description": "Учебный процесс: этап 8",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "artifact_write",
            "title": "Сохранить протокол",
            "description": "Сохранить протокол",
            "params": {
              "filename": "demo-result.txt",
              "text": "Демонстрация workflow успешно завершена; внешних отправок нет"
            }
          },
          {
            "action": "set",
            "title": "Сформировать результат",
            "description": "Сформировать результат",
            "params": {
              "state": "completed"
            }
          }
        ],
        "output": {}
      }
    }
  },
  {
    "id": "file-not-found",
    "number": "02",
    "title": "Файл не найден",
    "talkTime": "2 мин",
    "runtime": "≈ 2 сек",
    "result": "ОШИБКА",
    "tone": "error",
    "summary": "Учебный JSON workflow: ОШИБКА. Без входа в СБИС и отправки отчётности.",
    "points": [
      "Универсальные операции json-workflow",
      "Повторы определяются retry_policy",
      "Шаги и ошибки видны в журнале"
    ],
    "payload": {
      "priority": 20,
      "timeout_ms": 5000,
      "retry_policy": {
        "max_attempts": 1,
        "backoff_ms": 200
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "wait",
            "title": "Подготовить ошибку: этап 1",
            "description": "Подготовить ошибку: этап 1",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить ошибку: этап 2",
            "description": "Подготовить ошибку: этап 2",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить ошибку: этап 3",
            "description": "Подготовить ошибку: этап 3",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить ошибку: этап 4",
            "description": "Подготовить ошибку: этап 4",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить ошибку: этап 5",
            "description": "Подготовить ошибку: этап 5",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "assert",
            "title": "Учебная ошибка поиска",
            "description": "Учебная ошибка поиска",
            "params": {
              "condition": false,
              "error_code": "FILE_NOT_FOUND",
              "message": "Учебный набор файлов пуст"
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется: этап 1",
            "description": "Не выполняется: этап 1",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется: этап 2",
            "description": "Не выполняется: этап 2",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется: этап 3",
            "description": "Не выполняется: этап 3",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется: этап 4",
            "description": "Не выполняется: этап 4",
            "params": {
              "duration_ms": 100
            }
          }
        ],
        "output": {}
      }
    }
  },
  {
    "id": "retry",
    "number": "03",
    "title": "Повтор после сбоя",
    "talkTime": "3 мин",
    "runtime": "≈ 4 сек",
    "result": "2-Я ПОПЫТКА",
    "tone": "retry",
    "summary": "Учебный JSON workflow: 2-Я ПОПЫТКА. Без входа в СБИС и отправки отчётности.",
    "points": [
      "Универсальные операции json-workflow",
      "Повторы определяются retry_policy",
      "Шаги и ошибки видны в журнале"
    ],
    "payload": {
      "priority": 30,
      "timeout_ms": 8000,
      "retry_policy": {
        "max_attempts": 2,
        "backoff_ms": 700
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "wait",
            "title": "Подготовить повтор: этап 1",
            "description": "Подготовить повтор: этап 1",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить повтор: этап 2",
            "description": "Подготовить повтор: этап 2",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить повтор: этап 3",
            "description": "Подготовить повтор: этап 3",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить повтор: этап 4",
            "description": "Подготовить повтор: этап 4",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Подготовить повтор: этап 5",
            "description": "Подготовить повтор: этап 5",
            "params": {
              "duration_ms": 100
            }
          },
          {
            "action": "wait",
            "title": "Начать попытку",
            "description": "Начать попытку",
            "params": {
              "duration_ms": 200
            }
          },
          {
            "action": "compute",
            "title": "Проверить номер попытки",
            "description": "Проверить номер попытки",
            "params": {
              "expression": "context.attempt===1"
            },
            "save_as": "first_attempt"
          },
          {
            "action": "if",
            "title": "Создать ошибку только на первой попытке",
            "description": "API повторяет весь workflow по retry_policy.",
            "params": {
              "condition": "{{first_attempt}}"
            },
            "then": [
              {
                "action": "fail",
                "title": "Контролируемая ошибка",
                "description": "Контролируемая ошибка",
                "params": {
                  "error_code": "DEMO_RETRY",
                  "message": "Первая попытка завершается учебной ошибкой"
                }
              }
            ],
            "else": []
          },
          {
            "action": "artifact_write",
            "title": "Сохранить успешный результат",
            "description": "Сохранить успешный результат",
            "params": {
              "filename": "retry-result.txt",
              "text": "Вторая попытка успешно выполнена"
            }
          },
          {
            "action": "set",
            "title": "Вернуть номер попытки",
            "description": "Вернуть номер попытки",
            "params": {
              "result": {
                "state": "completed",
                "attempt": "{{attempt}}"
              }
            }
          }
        ],
        "output": {
          "Rezult_1": "{{result}}"
        }
      }
    }
  },
  {
    "id": "timeout",
    "number": "04",
    "title": "Контроль тайм-аута",
    "talkTime": "2 мин",
    "runtime": "≈ 2 сек",
    "result": "ТАЙМ-АУТ",
    "tone": "timeout",
    "summary": "Учебный JSON workflow: ТАЙМ-АУТ. Без входа в СБИС и отправки отчётности.",
    "points": [
      "Универсальные операции json-workflow",
      "Повторы определяются retry_policy",
      "Шаги и ошибки видны в журнале"
    ],
    "payload": {
      "priority": 40,
      "timeout_ms": 5000,
      "retry_policy": {
        "max_attempts": 1,
        "backoff_ms": 200
      },
      "script": {
        "format": "json-workflow",
        "steps": [
          {
            "action": "wait",
            "title": "Подготовка тайм-аута: этап 1",
            "description": "Подготовка тайм-аута: этап 1",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Подготовка тайм-аута: этап 2",
            "description": "Подготовка тайм-аута: этап 2",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Подготовка тайм-аута: этап 3",
            "description": "Подготовка тайм-аута: этап 3",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Подготовка тайм-аута: этап 4",
            "description": "Подготовка тайм-аута: этап 4",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Превысить тайм-аут шага",
            "description": "Превысить тайм-аут шага",
            "params": {
              "duration_ms": 1200
            },
            "timeout_ms": 250
          },
          {
            "action": "wait",
            "title": "Не выполняется после тайм-аута: этап 1",
            "description": "Не выполняется после тайм-аута: этап 1",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется после тайм-аута: этап 2",
            "description": "Не выполняется после тайм-аута: этап 2",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется после тайм-аута: этап 3",
            "description": "Не выполняется после тайм-аута: этап 3",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется после тайм-аута: этап 4",
            "description": "Не выполняется после тайм-аута: этап 4",
            "params": {
              "duration_ms": 50
            }
          },
          {
            "action": "wait",
            "title": "Не выполняется после тайм-аута: этап 5",
            "description": "Не выполняется после тайм-аута: этап 5",
            "params": {
              "duration_ms": 50
            }
          }
        ],
        "output": {}
      }
    }
  }
];

export const blankScenario = {
  "priority": 100,
  "timeout_ms": 30000,
  "retry_policy": {
    "max_attempts": 1,
    "backoff_ms": 500
  },
  "context": {
    "target_url": "https://example.org"
  },
  "script": {
    "format": "json-workflow",
    "steps": [
      {
        "action": "browser_launch",
        "title": "Запустить браузер",
        "description": "Запустить браузер",
        "params": {}
      },
      {
        "action": "browser_steps",
        "title": "Открыть целевой адрес",
        "description": "Открыть целевой адрес",
        "params": {
          "steps": [
            {
              "type": "navigate",
              "url": "{{target_url}}"
            }
          ]
        }
      }
    ],
    "output": {},
    "title": "Новый универсальный JSON workflow"
  }
};
