# Установить на одну УН

Для автоматического выбора между новой установкой, обновлением и восстановлением используйте [единый установщик](11-install-or-repair.md). Ниже описана ручная первоначальная установка.

## Подготовить

1. Выделите свободную Windows Server 2022. Установите Node.js 24+ для всей машины, Яндекс Браузер. Создайте robot, войдите под ним, настройте Saby/криптопровайдер/ЭЦП и проверьте вход вручную.
2. На компьютере с доступом к Git получите согласованный commit. Используйте точный SHA вместо подвижного main:

```powershell
git clone git@github.com:companyZ-1C/script_factory.git
cd script_factory
git fetch origin
$release = 'bd57928' # пример API 0.11.0; для следующего релиза замените
New-Item C:\Deploy -ItemType Directory -Force | Out-Null
git archive --format=zip --output C:\Deploy\release.zip $release
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать архив' }
Get-FileHash C:\Deploy\release.zip -Algorithm SHA256
```

3. Передайте архив на УН. В повышенной Windows PowerShell 5.1 распакуйте **новую установку** в `C:\script_factory`. Не распаковывайте поверх работающей версии; для неё есть инструкция обновления.

```powershell
Expand-Archive C:\Deploy\release.zip C:\script_factory
cd C:\script_factory
Copy-Item windows\.env.example .env
notepad .env
```

## Заполнить конфигурацию

Укажите индивидуальные `UN_ID`, `API_KEY`, `WEB_PASSWORD`, правильные пути и порт. `HOST=0.0.0.0` разрешает внешние подключения при подходящем Firewall/маршрутизации. Для СБИС установите `MAX_PARALLEL_JOBS=1`. Оставьте питание выключенным до завершения пилота. Для callback заполните CALLBACK_AUTH_USERNAME и CALLBACK_AUTH_PASSWORD: используется только HTTP Basic.

`FILESYSTEM_ALLOWED_ROOTS` на Windows разделяется точкой с запятой, например:

```dotenv
FILESYSTEM_ALLOWED_ROOTS=C:/отчеты;C:/Отчеты_загруженные;C:/Отчеты_с_ошибками;C:/ScriptFactoryData
DATA_DIR=C:/ScriptFactoryData
PORT=33001
```

Предоставьте robot доступ к рабочим каталогам. Для сетевых UNC-путей нужны сетевые права именно robot; диск Z: из сеанса администратора не подходит. Не помещайте секреты в Git. Полный список — [справочник](07-env-reference.md).

## Установить запуск

```powershell
.\windows\install-task.ps1 -ProjectPath C:\script_factory -Port 33001
.\windows\install-saby-task.ps1 -ProjectPath C:\script_factory
```

Для другой учётной записи добавьте к первой команде `-RunAsUser "$env:COMPUTERNAME\robot2"`. Пользователь должен существовать. Порт команды должен совпадать с PORT в .env. Если Saby стоит по другому пути, передайте `-ExecutablePath`. Установщик создаст SYSTEM-задачу API, пользовательскую задачу worker и секрет их локального канала. Вторая команда отдельно создаёт запуск Saby под worker.

## Проверить

```powershell
Invoke-RestMethod http://127.0.0.1:33001/live
Invoke-RestMethod http://127.0.0.1:33001/health
Get-ScheduledTask -TaskName 'ScriptFactory-Test-UN','ScriptFactory-Test-UN-Worker','ScriptFactory-Saby' |
  Select-Object TaskName,State,@{Name='User';Expression={$_.Principal.UserId}}
```

Требуется ready=true, правильный UN_ID и версия. Без входа robot API отвечает, но задания до готовности worker не принимает. Для выполнения после перезагрузки без RDP администратор отдельно настраивает автоматический вход robot; установщик этого не делает.

Проверьте тот же HTTP-адрес с компьютера 1С, затем [безопасный сценарий](06-first-script.md). HTTPS без TLS-прокси здесь не появится. Реальную отправку отчётности для smoke-теста не используйте. Затем выполните пилот перезагрузки/закрытия RDP по [подробной инструкции](../project-guide/12-api-worker-startup.md).

Для подключения к оркестратору выполните регистрацию УН и установку агента по [инструкции](../project-guide/11-fleet-updates.md). Адрес центра и индивидуальный токен нужны до установки агента.
