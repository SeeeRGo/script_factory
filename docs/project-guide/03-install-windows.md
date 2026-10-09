# Установить систему на Windows-УН

## 1. Подготовить программы и пользователя

Нужны Windows, Node.js 24+ для всей машины, Яндекс Браузер, каталог проекта и его npm-зависимости. Для сценария СБИС дополнительно нужны Saby/СБИС Плагин, криптопровайдер и ЭЦП под тем Windows-пользователем, который запускает worker. Эти компоненты настраиваются средствами их поставщиков; система не устанавливает и не выпускает ЭЦП.

Проверьте вручную вход по нужной подписи под будущим worker-пользователем. ЭЦП другого пользователя Windows может быть недоступна worker. Для BROWSER_HEADLESS=false пользователь должен оставаться залогинен: сворачивание RDP и выход из Windows — разные операции. SSH удобен для администрирования, но необязателен; возможен RDP.

Входящие API-запросы должны доходить до адреса/порта УН; нужны Windows Firewall и, при наличии, проброс на маршрутизаторе. Сервис внутри УН не настраивает внешний NAT. Для ip-check нужен исходящий HTTPS к ipify и действующие настройки IP-монитора.

## 2. Положить проект в один известный каталог

Далее пример `C:\script_factory`. Не накладывайте новый проект поверх неизвестной старой установки. Для существующей УН используйте [обновление](04-update-one-un.md).

Получите ZIP согласованного релиза от разработчика либо клонируйте Git и выберите конкретный commit. В корне должны лежать package.json, package-lock.json, src/server.js, windows/start-worker.ps1, windows/install-task.ps1 и windows/.env.example. ZIP из инструкции обновления имеет эти файлы прямо в корне; ZIP «Download source» GitHub обычно содержит дополнительную папку — сначала перенесите её содержимое в каталог проекта.

Откройте Windows PowerShell **от имени администратора**:

```powershell
$ProjectPath = 'C:\script_factory'
Set-Location $ProjectPath
node --version
npm.cmd --version
Copy-Item windows\.env.example .env
notepad .env
```

Copy-Item выполняется только при первой установке. При наличии .env не перезаписывайте его шаблоном.

## 3. Заполнить конфигурацию

| Переменная | Что задать |
| --- | --- |
| API_KEY | Собственный ключ для 1С; не оставлять dev-secret/replace |
| UN_ID | Уникальный постоянный идентификатор УН |
| WEB_LOGIN / WEB_PASSWORD | Вход в веб-интерфейс; отдельный от ключа API |
| HOST / PORT | `0.0.0.0` и `33001`, если доступ нужен с других компьютеров |
| DATA_DIR | Например `C:/ScriptFactoryData`; база и артефакты переживают обновления |
| FILESYSTEM_ALLOWED_ROOTS | Корни через `;`, включая каталоги рабочих XML и архивов |
| PUPPETEER_EXECUTABLE_PATH | Реальный полный путь к browser.exe |
| BROWSER_PRODUCT | `yandex` для Яндекс Браузера; уже задано в Windows-шаблоне |
| BROWSER_HEADLESS | `false` для видимой отладки СБИС |
| MAX_PARALLEL_JOBS | Для одного кабинета/сеанса СБИС — `1` |
| CALLBACK_AUTH_TOKEN | Токен авторизации callback; текущий Windows preflight требует его заполнить |
| CALLBACK_ALLOWED_ORIGINS | Допустимый origin 1С, например `http://1c-test.local:8080`, без пути обработчика |
| NOVNC_ENABLED | Для Windows/RDP обычно `false` |

Пример только несекретных строк:

```dotenv
HOST=0.0.0.0
PORT=33001
DATA_DIR=C:/ScriptFactoryData
FILESYSTEM_ALLOWED_ROOTS=C:/Reports;C:/ScriptFactoryData
PUPPETEER_EXECUTABLE_PATH=C:/Program Files/Yandex/YandexBrowser/Application/browser.exe
BROWSER_PRODUCT=yandex
BROWSER_HEADLESS=false
MAX_PARALLEL_JOBS=1
NOVNC_ENABLED=false
```

Заполните API_KEY, WEB_PASSWORD, CALLBACK_AUTH_TOKEN своими значениями. Шаблон windows/.env.example задаёт параллельность 3 — для СБИС измените её на 1. Параметр -Port установщика сам не меняет PORT в .env: оба значения должны совпадать.

Создайте каталоги и предоставьте worker-пользователю чтение программы, доступ к .env, запись в DATA_DIR и рабочие корни. Не распечатывайте весь .env в журнал или переписку.

## 4. Настроить IP-монитор для СБИС

Сценарий СБИС вызывает system_ip_check. По умолчанию читается `C:\_external ip monitor\settings.ini`:

```ini
[main]
ip_adress=ФАКТИЧЕСКИЙ_ВНЕШНИЙ_IP
```

Имя ключа именно `ip_adress`. Здесь должно быть действующее значение, а не placeholder. Не заменяйте работающие настройки монитора для обхода проверки. Если используется другой файл, задайте IP_MONITOR_SETTINGS_PATH в .env. Допустимы IPv4 и IPv6. Health не обращается к ipify, поэтому ready=true не доказывает успех ip-check.

## 5. Установить зависимости и задачу

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm.cmd ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'Не установлены зависимости' }

& .\windows\install-task.ps1 `
  -ProjectPath $ProjectPath `
  -TaskName 'ScriptFactory-Test-UN' `
  -RunAsUser 'ИМЯ_ПК\Robot' `
  -Port 33001 `
  -SkipDependencyInstall
```

Замените пользователя существующим worker-пользователем. Используем npm.cmd явно: Windows может выбрать npm.ps1, блокируемый ExecutionPolicy. -SkipDependencyInstall предотвращает повторный вызов npm внутри старого установщика.

Установщик проверяет конфигурацию, регистрирует интерактивную Scheduled Task с запуском при входе указанного пользователя, включает перезапуск при сбое и пытается создать входящее правило Firewall. Пользователь должен быть залогинен. Не запускайте две задачи на один порт/один DATA_DIR.

При блокировке выполнения .ps1 запустите отдельное окно:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass
```

Это настройка одного процесса PowerShell, а не постоянное отключение политики на всей машине.

## 6. Проверить установленную УН

```powershell
$h = Invoke-RestMethod http://127.0.0.1:33001/health -TimeoutSec 10
$h | Select-Object status,ready,version,release_date,un_id
Get-ScheduledTask -TaskName 'ScriptFactory-Test-UN' | Select-Object TaskName,State
```

Требуются ready=true, нужный UN_ID, ожидаемая версия и успешные проверки базы, файловой системы и браузера. После этого проверьте из компьютера 1С тот же адрес, затем [безопасное задание и IP](06-api-1c.md).

В браузере доступны `/`, `/docs`, `/queue`. Вход в веб-интерфейс использует WEB_LOGIN/WEB_PASSWORD, API — X-API-Key.

Если не запустилось: выполните `windows/start-worker.ps1` вручную под worker-пользователем после остановки его задачи и посмотрите ошибку; проверьте node в PATH, путь браузера, .env и права каталогов. Перед возвратом Scheduled Task завершите ручной процесс, чтобы не оставить два worker.
