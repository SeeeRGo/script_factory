# Живой показ Chromium через noVNC

## Что запускается

В демонстрационном режиме один контейнер поднимает четыре процесса:

```text
Puppeteer → Chromium → Xvfb :99 → x11vnc :5900 → noVNC/websockify :33303
                 └────────── Фабрика сценариев :33001
```

Порт VNC `5900` остаётся внутри контейнера. Web-клиент noVNC и websockify работают на
порту `33303`, который по умолчанию публикуется только на `127.0.0.1` хоста.

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

## Подключение через SSH

На компьютере докладчика выполните:

```bash
ssh -N \
  -L 33001:127.0.0.1:33001 \
  -L 33303:127.0.0.1:33303 \
  user@server
```

Откройте:

- `http://127.0.0.1:33001` — Фабрика сценариев;
- `http://127.0.0.1:33303/vnc.html?autoconnect=1&resize=scale&path=websockify` — экран Chromium.

После авторизации на главной странице появляется встроенная панель **«Экран Chromium»**
с noVNC-клиентом. Ссылка **«Открыть отдельно ↗»** выводит тот же экран в новую вкладку —
это удобно для второго монитора или проектора.

До запуска задания виртуальный дисплей может быть пустым. После нажатия «Запустить» на
нём появится Chromium и начнёт выполнять Recorder JSON.

## Если SSH-туннель невозможен

Допускается публикация web-порта на внешнем интерфейсе:

```text
NOVNC_BIND_HOST=0.0.0.0
NOVNC_PASSWORD=<отдельный-сложный-пароль>
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
