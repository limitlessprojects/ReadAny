#!/bin/bash
# dev-web-ctl.sh — deterministic vite web-server control (sandbox-safe)
# Usage:
#   dev-web-ctl.sh start   → kill anything on :5183, start vite, verify READY in log
#   dev-web-ctl.sh stop    → kill whatever holds :5183
#   dev-web-ctl.sh status  → print state
PORT=5183
LOG=/tmp/vite-web.log
APP=/home/z/my-project/ReadAny/packages/app

port_pid() {
  ss -tlnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1
}

stop() {
  local pid
  pid=$(port_pid)
  if [ -n "$pid" ]; then
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi
  # belt and suspenders
  pkill -9 -f "bin/vite --port $PORT" 2>/dev/null
  sleep 0.5
  if [ -n "$(port_pid)" ]; then
    echo "STOP-FAILED pid=$(port_pid)"
    return 1
  fi
  echo "STOPPED"
  return 0
}

start() {
  stop > /dev/null 2>&1
  : > "$LOG"
  (cd "$APP" && READANY_WEB=1 ../../node_modules/.bin/vite --port $PORT --host 127.0.0.1 >> "$LOG" 2>&1 &)
  # verify OUR process is ready: log must contain "ready in"
  local ok=0
  for i in $(seq 1 40); do
    if grep -q "ready in" "$LOG" 2>/dev/null && [ "$(port_pid)" != "" ]; then ok=1; break; fi
    sleep 0.5
  done
  if [ "$ok" = "1" ]; then
    echo "STARTED pid=$(port_pid)"
    return 0
  fi
  echo "START-FAILED"
  tail -8 "$LOG"
  return 1
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status)
    pid=$(port_pid)
    if [ -n "$pid" ]; then echo "RUNNING pid=$pid"; else echo "STOPPED"; fi
    ;;
esac
