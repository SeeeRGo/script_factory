# Версионирование Script Factory

`package.json` является источником номера и даты релиза:

```json
{
  "version": "0.4.0",
  "releaseDate": "07.09.2026"
}
```

Каждый коммит должен повышать SemVer-номер. Дата имеет формат `DD.MM.YYYY` и может
совпадать у нескольких коммитов, сделанных в один день.

## Настроить проверку один раз

После клонирования репозитория выполните:

```bash
npm run hooks:install
```

Команда включает хранящийся в репозитории pre-commit hook. Он проверяет, что:

- версия в `package.json` стала больше;
- дата релиза заполнена корректно;
- версии в `package.json`, `package-lock.json` и `openapi.yaml` совпадают.

## Подготовить очередной коммит

До `git add` и `git commit` повысьте версию:

```bash
# Обычный коммит или исправление: 0.4.0 → 0.4.1
npm run version:bump -- patch

# Новая обратно совместимая функция: 0.4.0 → 0.5.0
npm run version:bump -- minor

# Несовместимое изменение API: 0.4.0 → 1.0.0
npm run version:bump -- major
```

Команда одновременно обновляет `releaseDate`, корневую версию в `package-lock.json` и
`info.version` в `openapi.yaml`. После этого добавьте изменения версии в тот же коммит:

```bash
git add package.json package-lock.json openapi.yaml
git commit
```

Ручная проверка без создания коммита:

```bash
npm run version:check
```

## Версия запущенной УН

Оба healthcheck возвращают данные непосредственно из `package.json` запущенного
релиза:

```json
{
  "status": "ok",
  "ready": true,
  "version": "0.4.0",
  "release_date": "07.09.2026"
}
```

Адреса:

- `GET /health`;
- `GET /api/v2/health`.
