# Живой показ Chromium через noVNC

## Что запускается

В демонстрационном режиме один контейнер поднимает четыре процесса:

```text
Puppeteer → Chromium → Xvfb :99 → x11vnc :5900 → noVNC/websockify :33303
                 └────────── Фабрика сценариев :33001
```

Порт VNC `5900` остаётся внутри контейнера. Web-клиент noVNC и websockify работают на
порту `33303`. Встроенный iframe обращается к авторизованному same-origin маршруту
`/browser-live/`, поэтому отдельный публичный порт и TLS-сертификат для iframe не нужны.

## Запуск на сервере

Заполните `.env` и запустите:

```bash
docker compose up --build -d
docker compose ps
```

Для режима презентации должны быть установлены:

```text
NOVNC_ENABLED=true
BROWSER_HEADLESS=false
BROWSER_STEP_DELAY_MS=350
BROWSER_HOLD_OPEN_MS=5000
NOVNC_BIND_HOST=127.0.0.1
NOVNC_PORT=33303
```

`BROWSER_STEP_DELAY_MS` добавляет предсказуемую паузу между Recorder-шагами, а `BROWSER_HOLD_OPEN_MS` оставляет
финальное состояние на экране до закрытия браузера.

## Подключение только через SSH

Если прямой публичный доступ не нужен, сначала задайте в `.env`:

```text
NOVNC_BIND_HOST=127.0.0.1
```

На компьютере докладчика выполните:

```bash
ssh -N \
  -L 33001:127.0.0.1:33001 \
  user@server
```

Откройте:

- `http://127.0.0.1:33001` — Фабрика сценариев со встроенным экраном Chromium.

Отдельный проброс `33303` для iframe не требуется. Если нужен прямой доступ к noVNC без
интерфейса Фабрики, добавьте к команде SSH
`-L 33303:127.0.0.1:33303` и откройте
`http://127.0.0.1:33303/vnc.html?autoconnect=1&resize=scale&path=websockify`.

После авторизации на главной странице появляется встроенная панель **«Экран Chromium»**
с noVNC-клиентом. И iframe, и ссылка **«Открыть отдельно ↗»** используют маршрут
`/browser-live/` на том же адресе, что и интерфейс. Это работает через один открытый порт
приложения и не создаёт mixed-content при HTTPS.

До запуска задания виртуальный дисплей может быть пустым. После нажатия «Запустить» на
нём появится Chromium и начнёт выполнять Recorder JSON.

## Прямой доступ по открытому порту

Для отдельного прямого доступа к noVNC по публичному IP сервера используйте:

```text
NOVNC_BIND_HOST=0.0.0.0
NOVNC_PASSWORD=<отдельный-сложный-пароль>
NOVNC_PUBLIC_URL=http://server.example:33303/vnc.html?autoconnect=1&resize=scale&path=websockify
```

После изменения перезапустите контейнер:

```bash
docker compose up -d --force-recreate
```

Не открывайте raw VNC-порт `5900`. Обычный noVNC на `ws://` не шифрует изображение и
ввод, поэтому внешний порт допустим только в доверенной сети. Для интернета используйте
SSH/VPN либо TLS-терминацию reverse proxy и задайте полный адрес через
`NOVNC_PUBLIC_URL`.

## Настройка наглядности

```text
BROWSER_STEP_DELAY_MS=500
BROWSER_HOLD_OPEN_MS=10000
NOVNC_GEOMETRY=1600x1000x24
BROWSER_WINDOW_WIDTH=1560
BROWSER_WINDOW_HEIGHT=940
```

После изменения геометрии контейнер требуется пересоздать. Для рабочего режима без
трансляции верните:

```text
NOVNC_ENABLED=false
BROWSER_HEADLESS=true
BROWSER_STEP_DELAY_MS=0
BROWSER_HOLD_OPEN_MS=0
```

## Диагностика

```bash
docker compose ps
docker compose logs --tail=100 script-factory
curl -I http://127.0.0.1:33303/vnc.html
curl http://127.0.0.1:33001/health
```

В `/health` должны быть значения:

```json
{
  "browser_replay": {
    "headless": false,
    "step_delay_ms": 350,
    "live_view": {
      "enabled": true,
      "port": 33303
    }
  }
}
```

Если noVNC открывается, но Chromium не появляется, проверьте одновременно
`NOVNC_ENABLED=true`, `BROWSER_HEADLESS=false` и наличие `DISPLAY=:99` в контейнере.
