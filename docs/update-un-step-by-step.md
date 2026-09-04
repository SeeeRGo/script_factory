# Как обновить Windows-УН через Ansible

Если Ansible не используется, см. отдельную инструкцию
[`Как обновить Windows-УН вручную`](update-un-manual-step-by-step.md).

Это короткая инструкция для обычного обновления уже настроенной УН. Основной принцип:
сначала обновляем одну пилотную УН, проверяем её и только потом обновляем остальные.

В примерах:

- `/opt/script_factory` — каталог проекта на Linux-компьютере с Ansible;
- `un-001` — имя пилотной УН в Ansible inventory;
- `f586f88` — номер версии Git, которую нужно установить.

Замените эти значения на свои.

## Что должно быть подготовлено один раз

Перед первым обновлением системный администратор должен:

1. Подготовить Linux-компьютер, с которого запускается Ansible.
2. Настроить WinRM-доступ с него к Windows-УН.
3. Установить на УН Node.js 24+ и Яндекс Браузер.
4. Создать Windows-пользователя, под которым будет работать worker.
5. Заполнить production inventory и зашифрованный Ansible Vault.
6. Установить необходимые Ansible-коллекции:

```bash
cd /opt/script_factory/ansible
ansible-galaxy collection install -r requirements.yml
```

Подробности первоначальной настройки находятся в
[`ansible/README.md`](../ansible/README.md). Следующие разделы описывают уже обычное
обновление.

## Шаг 1. Получить новую версию проекта

На Linux-компьютере с Ansible выполните:

```bash
cd /opt/script_factory
git fetch --tags origin
git checkout main
git pull --ff-only
git rev-parse --short=12 HEAD
```

Последняя команда покажет номер версии, например:

```text
f586f88a12bc
```

Скопируйте этот номер. Далее он обозначен как `<ВЕРСИЯ>`.

Важно: устанавливайте конкретный номер Git, а не просто `HEAD`. Тогда на всех УН будет
точно одна и та же версия, а в случае проблемы будет понятно, что откатывать.

## Шаг 2. Проверить связь с пилотной УН

```bash
cd /opt/script_factory/ansible
ansible script_factory_windows \
  -i inventories/production/hosts.yml \
  --limit un-001 \
  -m ansible.windows.win_ping \
  --ask-vault-pass
```

Ansible попросит пароль от Vault. Успешный результат содержит:

```text
"ping": "pong"
```

Если УН недоступна или показано `UNREACHABLE`, обновление не запускайте. Сначала нужно
исправить WinRM, сеть, имя компьютера или учётные данные.

Перед продолжением:

1. Временно остановите отправку новых заданий из 1С на пилотную УН.
2. Убедитесь, что Windows-пользователь worker залогинен на УН. Это необходимо для
   видимого браузера.
3. Проверьте очередь:

```bash
curl http://IP_ПИЛОТНОЙ_УН:33001/health
```

Продолжайте только при `queue.running: 0` и `queue.queued: 0`. Playbook также проверяет
это сам и не станет останавливать worker с незавершёнными заданиями.

## Шаг 3. Проверить playbook

Подставьте номер версии из шага 1:

```bash
ansible-playbook \
  -i inventories/production/hosts.yml \
  deploy-windows.yml \
  --syntax-check \
  --ask-vault-pass \
  -e script_factory_git_ref=<ВЕРСИЯ>
```

При успешной проверке Ansible выведет имя playbook без сообщения об ошибке.

## Шаг 4. Обновить одну пилотную УН

```bash
ansible-playbook \
  -i inventories/production/hosts.yml \
  deploy-windows.yml \
  --limit 'localhost:un-001' \
  --ask-vault-pass \
  -e script_factory_git_ref=<ВЕРСИЯ>
```

`localhost` удалять из команды нельзя: на нём Ansible собирает архив обновления.

Во время обновления Ansible:

1. копирует новую версию на УН;
2. устанавливает зависимости и запускает предварительную проверку;
3. останавливает старый worker;
4. запускает новый worker;
5. ждёт успешный `/health`;
6. при ошибке автоматически возвращает предыдущую версию.

В конце найдите блок `PLAY RECAP`. Успешное обновление выглядит примерно так:

```text
un-001 : ok=... changed=... unreachable=0 failed=0 rescued=0
```

Главные признаки успеха — `unreachable=0` и `failed=0`.

## Шаг 5. Проверить УН после обновления

Откройте в браузере или выполните:

```bash
curl http://IP_ПИЛОТНОЙ_УН:33001/health
```

В ответе должны быть:

```json
{
  "status": "ok",
  "ready": true,
  "un_id": "un-001"
}
```

Также проверьте:

- `un_id` соответствует нужной УН;
- `checks.database.status` равен `ok`;
- `checks.filesystem.status` равен `ok`;
- `checks.browser.status` равен `ok`;
- открывается `http://IP_ПИЛОТНОЙ_УН:33001/queue`;
- тестовое задание из 1С успешно выполняется и возвращает результат.

После этой проверки можно снова разрешить 1С отправлять задания на пилотную УН.

На самой Windows-УН номер принятой версии можно посмотреть командой:

```powershell
Get-Content 'C:\ProgramData\ScriptFactory\shared\current-release.txt'
```

Он должен совпадать с `<ВЕРСИЯ>`.

## Шаг 6. Обновить остальные УН

Выполняйте этот шаг только после успешной проверки пилотной УН. Сначала приостановите
отправку новых заданий из 1С на обновляемую группу и дождитесь пустых очередей:

```bash
ansible-playbook \
  -i inventories/production/hosts.yml \
  deploy-windows.yml \
  --limit 'localhost:script_factory_windows:!un-001' \
  --ask-vault-pass \
  -e script_factory_git_ref=<ВЕРСИЯ>
```

По умолчанию машины обновляются партиями по 25%. Это уменьшает число УН, затронутых
одной ошибкой. Если требуется обновить всю выбранную группу одновременно, добавьте:

```text
-e script_factory_serial=100%
```

Использовать `100%` рекомендуется только после успешного пилота.

После успешного `PLAY RECAP` и проверки `/health` снова разрешите отправку заданий из
1С на обновлённые УН.

## Что делать, если обновление завершилось ошибкой

1. Не удаляйте каталоги в `C:\ProgramData\ScriptFactory` вручную.
2. Посмотрите в `PLAY RECAP`, какая УН имеет `failed=1` или `unreachable=1`.
3. Если ошибка произошла до переключения Scheduled Task, старый worker продолжит
   работать.
4. Если новый worker не прошёл `/health`, playbook сам переключит УН на предыдущие код
   и конфигурацию и проверит восстановленный `/health`.
5. Проверьте текущую версию и состояние задачи на проблемной УН:

```powershell
Get-Content 'C:\ProgramData\ScriptFactory\shared\current-release.txt'
Get-ScheduledTaskInfo -TaskName 'ScriptFactory-Worker'
Invoke-RestMethod 'http://127.0.0.1:33001/health' | ConvertTo-Json -Depth 8
```

Не запускайте массовое обновление, пока пилотная УН не возвращает `ready=true` и не
выполняет тестовое задание из 1С.

## Короткая памятка

Для каждого обновления порядок всегда один:

```text
получить версию → проверить win_ping → проверить playbook → обновить одну УН
→ проверить /health и задание из 1С → обновить остальные УН
```
