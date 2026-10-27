#!/usr/bin/env bash
# Holy Karaoke Stems — 종료 (서버만 끔, 데이터는 유지)
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"

if [ -f backend/run.pid ]; then
  PID="$(cat backend/run.pid 2>/dev/null || true)"
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -f backend/run.pid
fi
if command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null
fi
osascript -e 'display notification "서버를 종료했습니다" with title "Holy Karaoke Stems"' 2>/dev/null
exit 0
