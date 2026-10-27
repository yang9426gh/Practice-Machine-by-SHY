#!/usr/bin/env bash
# Holy Karaoke Stems — 실행 (단일 프로세스: FastAPI가 프론트까지 서빙)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"

# 프론트 빌드물 확인
if [ ! -f "$ROOT/frontend/out/index.html" ]; then
  echo "❌ frontend/out 없음 — 먼저 ./install.sh 실행"; exit 1
fi

# 기존 리스너 정리 (포트 재사용)
if command -v lsof >/dev/null 2>&1; then
  if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "↺ 포트 $PORT 기존 프로세스 종료"
    lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs -r kill || true
    sleep 1
  fi
fi

DATA_DIR="${HOLY_DATA_DIR:-$ROOT/backend/data}"
mkdir -p "$DATA_DIR"

echo "🎤 Holy Karaoke Stems 시작 → http://localhost:$PORT"
cd "$ROOT/backend"
source venv/bin/activate

# 백그라운드 실행 (기본) or 포그라운드 (HOLY_FOREGROUND=1)
if [ "${HOLY_FOREGROUND:-}" = "1" ]; then
  exec python -m uvicorn main:app --host 127.0.0.1 --port "$PORT"
else
  LOG="$ROOT/backend/run.log"
  nohup python -m uvicorn main:app --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
  echo $! > "$ROOT/backend/run.pid"
  # 기동 확인
  for i in $(seq 1 20); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
      echo "✅ 준비 완료 → http://localhost:$PORT (로그: $LOG, 종료: kill \$(cat backend/run.pid))"
      exit 0
    fi
    sleep 0.5
  done
  echo "⚠️ 기동 확인 실패 — 로그 확인: $LOG"
  exit 1
fi
