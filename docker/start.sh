#!/bin/sh
set -eu

novnc_enabled="${NOVNC_ENABLED:-false}"

if [ "$novnc_enabled" = "true" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  novnc_geometry="${NOVNC_GEOMETRY:-1440x900x24}"
  novnc_internal_port="${NOVNC_INTERNAL_PORT:-33303}"
  novnc_public_port="${NOVNC_PUBLIC_PORT:-33303}"
  vnc_port="${VNC_PORT:-5900}"
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  display_socket="/tmp/.X11-unix/X${display_number}"

  mkdir -p /tmp/.X11-unix /tmp/script-factory-novnc
  Xvfb "$DISPLAY" -screen 0 "$novnc_geometry" -ac -nolisten tcp &
  xvfb_pid=$!

  attempts=0
  while [ ! -S "$display_socket" ]; do
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
      echo "Xvfb завершился до создания дисплея $DISPLAY" >&2
      exit 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      echo "Xvfb не создал дисплей $DISPLAY за отведённое время" >&2
      exit 1
    fi
    sleep 0.05
  done

  if [ -n "${NOVNC_PASSWORD:-}" ]; then
    password_file=/tmp/script-factory-novnc/passwd
    x11vnc -storepasswd "$NOVNC_PASSWORD" "$password_file" >/dev/null
    x11vnc -display "$DISPLAY" -localhost -forever -shared -repeat -noxdamage -quiet \
      -rfbport "$vnc_port" -rfbauth "$password_file" &
  else
    x11vnc -display "$DISPLAY" -localhost -forever -shared -repeat -noxdamage -quiet \
      -rfbport "$vnc_port" -nopw &
  fi

  websockify --web=/usr/share/novnc "0.0.0.0:${novnc_internal_port}" "127.0.0.1:${vnc_port}" &
  echo "noVNC inside container: http://127.0.0.1:${novnc_internal_port}/vnc.html?autoconnect=1&resize=scale&path=websockify"
  if [ -n "${NOVNC_PUBLIC_URL:-}" ]; then
    echo "Chromium live view: ${NOVNC_PUBLIC_URL}"
  else
    echo "Chromium live view on Docker host: http://127.0.0.1:${novnc_public_port}/vnc.html?autoconnect=1&resize=scale&path=websockify"
  fi
  echo "Chromium display: $DISPLAY ($novnc_geometry)"
fi

exec "$@"
