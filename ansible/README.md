# Массовое развёртывание Windows-УН через Ansible

Для обычного обновления по готовым настройкам используйте короткую
[`пошаговую инструкцию`](../docs/update-un-step-by-step.md). Этот документ содержит
полное описание настройки и эксплуатации.

Ansible является основным способом синхронного обновления группы Windows-УН. Он
запускается с Linux-контроллера и подключается к Windows по WinRM. Сам worker остаётся
нативным Windows-процессом в Scheduled Task: это необходимо для видимого Яндекс
Браузера и работы в пользовательской сессии.

## Что делает playbook

- собирает ZIP только из отслеживаемых Git-файлов указанного commit/tag;
- кладёт код в неизменяемый каталог
  `C:\ProgramData\ScriptFactory\releases\<release-id>`;
- хранит версионные `.env`, SQLite и рабочие файлы отдельно в `shared`, поэтому
  обновление их не удаляет и откат возвращает также конфигурацию прежнего релиза;
- проверяет Node.js 24+, путь к Яндекс Браузеру и preflight;
- устанавливает production-зависимости, обновляет Scheduled Task и открывает порт;
- принимает релиз только после `/health`: HTTP 200, `ready=true`, правильный `un_id`
  и успешные проверки БД, файловой системы и браузера;
- при ошибке health-gate возвращает Scheduled Task на предыдущий релиз.

Playbook не устанавливает Node.js и Яндекс Браузер: их версии и корпоративные политики
обновления лучше вести отдельной ролью после согласования с ИТ. Он также не создаёт
Windows-пользователя исполнителя и не выполняет интерактивный вход за него.

## Предварительная подготовка

1. Подготовьте Linux-контроллер с Ansible и доступом к репозиторию.
2. Включите на УН WinRM HTTPS, выдайте deployment-учётной записи административные
   права и настройте Kerberos либо другой согласованный transport.
3. Установите на УН Node.js 24+ и Яндекс Браузер.
4. Создайте отдельную Windows-учётную запись worker и один раз войдите под ней.
   Для `BROWSER_HEADLESS=false` эта сессия должна оставаться активной.
5. Установите коллекции на контроллере:

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml
```

Для WinRM transport установите также Python-зависимость, соответствующую выбранному
connection plugin (`pywinrm` или `pypsrp`).

Playbook добавляет worker-учётной записи право `SeBatchLogonRight`. Доменная GPO может
перезаписать локальное право — это нужно проверить с администраторами домена до пилота.

## Inventory и секреты

Скопируйте `inventories/example` в `inventories/production`, заполните адреса,
`script_factory_un_id`, `script_factory_run_as_user` и полный путь браузера для каждой
УН. Создайте каталог `group_vars/all`, скопируйте `vault.example.yml` в
`group_vars/all/vault.yml`, замените заглушки и зашифруйте файл:

```bash
ansible-vault encrypt inventories/production/group_vars/all/vault.yml
```

Не коммитьте открытые пароли. Создаваемый `.env` доступен только SYSTEM, локальным
администраторам и соответствующей worker-учётной записи. `CALLBACK_ALLOWED_ORIGINS`
управляется переменной
`script_factory_callback_allowed_origins`; её назначение и проверка не меняются.
Значения, записываемые в `.env`, не должны содержать двойные кавычки или переносы строк;
playbook проверяет это до изменения УН.

## Проверка и раскатка

Сначала проверьте соединение и синтаксис:

```bash
cd ansible
ansible script_factory_windows -i inventories/production/hosts.yml -m ansible.windows.win_ping --ask-vault-pass
ansible-playbook -i inventories/production/hosts.yml deploy-windows.yml --syntax-check
```

Рекомендуемый процесс — pilot, затем партии:

```bash
# Одна пилотная УН, точная версия из Git
ansible-playbook -i inventories/production/hosts.yml deploy-windows.yml \
  --limit 'localhost:un-001' --ask-vault-pass \
  -e script_factory_git_ref=v0.4.0

# Остальные УН партиями по 25% (значение по умолчанию)
ansible-playbook -i inventories/production/hosts.yml deploy-windows.yml \
  --limit 'localhost:script_factory_windows:!un-001' --ask-vault-pass \
  -e script_factory_git_ref=v0.4.0
```

Для максимально синхронного запуска задайте `-e script_factory_serial=100%`. Это
быстрее, но увеличивает область отказа. Параллельность соединений задаёт `forks` в
`ansible.cfg`; для 200–300 УН увеличивайте её только после замера контроллера и сети.

Одинаковый `release-id` второй раз не разворачивается. Новый запуск должен ссылаться на
новый commit/tag. Рабочее дерево контроллера в архив не попадает, поэтому перед
промышленным запуском изменения необходимо закоммитить.

При применении `--limit` обязательно включайте `localhost`: первый play именно там
собирает архив релиза. Без `--limit` это не требуется.

## Откат и эксплуатация

При неуспешном healthcheck playbook автоматически возвращает предыдущую Scheduled
Task. Релизы не удаляются автоматически, чтобы ручной откат оставался возможен. После
успешного пилота старые каталоги можно удалить отдельной согласованной процедурой,
оставив как минимум текущий и предыдущий релизы.

Если worker не стартует, проверьте активную сессию `script_factory_run_as_user`, историю
Scheduled Task, путь браузера, затем выполните на УН:

```powershell
& 'C:\ProgramData\ScriptFactory\releases\<release-id>\windows\preflight.ps1' `
  -ProjectPath 'C:\ProgramData\ScriptFactory\releases\<release-id>' `
  -EnvFile 'C:\ProgramData\ScriptFactory\shared\configs\<release-id>.env' `
  -Port 33001 -ExpectServiceRunning
```

До пилота на реальных корпоративных УН playbook следует считать готовым базовым
механизмом, но не подтверждённой промышленной процедурой: отдельно проверяются WinRM,
Kerberos/сертификаты, доменные политики, ЭЦП/СБИС и поведение RDP-сессии.
