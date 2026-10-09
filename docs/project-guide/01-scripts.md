# Шпаргалка: самостоятельно собрать сценарий

## 1. С чего начать

Сначала соберите короткий проход: открыть страницу → дождаться элемента → выполнить действие → проверить результат. Затем добавляйте параметры, циклы и файлы. Удобнее обсуждать с разработчиком конкретный неработающий шаг и ожидаемое состояние, чем сразу весь большой сценарий.

Chrome DevTools → Recorder → Create a new recording → выполнить проход → остановить → Replay → Export → JSON. Экспорт JavaScript здесь не подходит. «Puppeteer JSON» означает именно запись Recorder для `@puppeteer/replay`.

Есть два варианта исполнения:

- Обычный Recorder JSON с `title`, `timeout`, `steps[].type` отправляется напрямую; это линейная запись.
- `format: "json-workflow"` с `steps[].action` добавляет переменные, условия, циклы и файлы. Запись Recorder помещается в `browser_steps.params.steps`.

`type: "click"` нельзя превращать в `action: "click"`: внешней операции click нет.

## 2. Перенести запись

Готовые [исходная запись](examples/recorder-source.json) и [workflow](examples/recorder-workflow.json) работают на HTML в `data:` URL, без чужого кабинета и внешних действий.

Для собственной записи сохраните её как `recording.json` в каталоге проекта и выполните:

```powershell
node docs/project-guide/tools/convert-recorder.mjs recording.json workflow.json
```

Команда проверяет запись Replay и создаёт оболочку с `browser_launch` и `browser_steps`, без перезаписи существующего файла. Она не придумывает проверки сайта или бизнес-условия. Общий тайм-аут задания нужно назначить отдельно.

Оболочка выглядит так:

```json
{
  "format": "json-workflow",
  "title": "Открыть документы",
  "default_step_timeout_ms": 60000,
  "context": { "url": "https://example.org/documents" },
  "steps": [
    { "action": "browser_launch" },
    {
      "action": "browser_steps",
      "params": {
        "timeout_ms": 30000,
        "steps": [
          { "type": "navigate", "url": "{{url}}" },
          { "type": "waitForElement", "selectors": [["#documents"]], "visible": true }
        ]
      }
    }
  ],
  "output": { "Rezult_1": { "state": "completed" } }
}
```

Адрес и селектор условные. Браузер запускается один раз; несколько browser_steps сохраняют общую сессию. Не оставляйте `close`, если дальше требуется читать страницу.

## 3. Параметры и результаты

`script.context` — значения по умолчанию; `context` задания переопределяет их поверхностно. Вложенный объект или массив заменяется целиком.

| Синтаксис | Что означает |
| --- | --- |
| `"{{inn}}"` | Взять значение с сохранением типа |
| `"{{file.path}}"` | Взять поле вложенного объекта |
| `"Протокол {{index}}"` | Подставить значение в строку |
| `"context.inn === context.actual_inn"` в expression | Вычислить JavaScript-выражение |

`{{inn == expected}}` не является условием. ИНН передавайте строкой; разрешения — Boolean `true/false`, не строками. В expression читайте `context.variable`, а не вставляйте пользовательское значение в код.

Чтение результата страницы:

```json
{
  "action": "browser_eval",
  "params": { "expression": "document.querySelector('#status').textContent.trim()" },
  "save_as": "status_text"
}
```

`save_as` сохраняет значение на верхнем уровне context: имя `status_text` допустимо, `result.status` — нет. Выражения должны возвращать JSON-совместимые данные. DOM-элемент не является результатом для 1С.

Итог задаёт корневой `output`, например `{"Rezult_1":"{{answer}}"}`. Публичный API возвращает его как **`job.result.Rezult_1`**, а не result.context.Rezult_1. Публичный сериализатор оставляет артефакты и поля `Rezult_N`, являющиеся объектами. Для результата в 1С используйте именно такой объект:

```json
{
  "action": "compute",
  "params": { "expression": "({state:'completed',status:context.status_text})" },
  "save_as": "answer"
}
```

## 4. Выбрать операцию

| Задача | Операция |
| --- | --- |
| Клик / ввод / переход из Recorder | `browser_steps` |
| Прочитать DOM, получить данные | `browser_eval` |
| Ждать конкретное состояние DOM | `browser_wait` |
| Посчитать значение без браузера | `compute` |
| Остановиться, если условие неверно | `assert` |
| Выбрать ветку | `if` |
| Обойти массив | `for_each` |
| Переиспользовать блок JSON | `call` + корневой `routines` |
| Перечислить файлы / проверить SHA | `files_list` / `file_verify` |
| Архивировать подтверждённую обработку | `file_archive` |
| Сохранить текст / снимок | `artifact_write` / `browser_screenshot` |
| Сделать фиксированную паузу | `wait` |

compute изолирован: нет DOM, Node, файлов или .env; синхронное выражение ограничено 1 секундой. browser_eval работает в браузере с DOM и копией context, допускает Promise. Изменения этой копии не меняют контекст исполнителя — используйте save_as.

Условие сначала вычислите, затем передайте Boolean:

```json
[
  { "action": "compute", "params": { "expression": "context.status_text === 'Готово'" }, "save_as": "ok" },
  { "action": "assert", "params": { "condition": "{{ok}}", "message": "Документ ещё не готов" } }
]
```

Это фрагмент steps, не отдельный готовый сценарий. Аналогично `if.params.condition` — Boolean, а не строка с кодом. Цикл содержит `params.items`, имя `as` и вложенные `steps`; подпрограмма — массив шагов внутри `routines`.

## 5. Файлы и ожидания

Пути — на УН, а не на компьютере 1С. Windows-путь в JSON: `"C:/Reports"` или `"C:\\Reports"`. Каталоги должны входить в FILESYSTEM_ALLOWED_ROOTS.

files_list перечисляет файлы непосредственно в каталоге, без рекурсивного обхода. Фильтруйте результат через compute. Для обычного input[type=file] внутри browser_steps используется расширение:

```json
{
  "type": "customStep",
  "name": "uploadFiles",
  "parameters": { "selector": "input[type=file]", "files": "{{upload_paths}}" }
}
```

upload_paths — массив путей. Передача файла полю ещё не подтверждает импорт; добавьте проверку результата сайта. Диалог стороннего Windows-приложения автоматически таким шагом не управляется.

Ожидайте элемент/статус вместо паузы наугад. `waitForExpression` с setTimeout — задержка, а не проверка готовности.

Три ограничения времени: API timeout_ms — всё задание; внешний step.timeout_ms — весь шаг; browser_steps.params.timeout_ms — шаги Replay внутри блока. Если увеличить только внутреннее ожидание, внешний тайм-аут всё равно может сработать. У циклов/вызовов нет отдельного тайм-аута по умолчанию, но можно задать явный.

## 6. Проверить и запустить

1. Начните с [smoke-workflow.json](examples/smoke-workflow.json): это безопасная проверка API, без браузера и отправки.
2. Для браузера выполните Recorder-пример дважды на тестовой УН.
3. Проверьте отсутствие файла, неправильную организацию и неподтверждённый результат.
4. Передайте полный JSON в script или script_text; [запуск из 1С](06-api-1c.md).
5. Проверьте job.status, job.error, job.result.Rezult_1 и скачайте артефакт.

title и description дают понятные имена в истории. Внешний browser_steps — один шаг истории; для диагностики разделите большой проход на именованные блоки. Циклы добавляют шаги динамически.

private:true скрывает параметры и результат конкретного шага в событиях, но не удаляет исходный JSON/context из сохранённого задания. Пароли не записывайте в сценарий. Финальный снимок успеха добавляйте явно; имя артефакта должно быть уникальным в задании.

Полная [инструкция переноса](../recorder-to-json-workflow.md) и [каталог операций](../../demo/json-workflow.md) содержат развёрнутые примеры.
