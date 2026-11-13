#!/usr/bin/env bash
# Practice Machine by SHY — 실행 (단일 프로세스: FastAPI가 프론트까지 서빙)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"

# 호스트 바인딩: settings.env 의 HOLY_HOST 값 우선 (없으면 127.0.0.1 = 이 컴퓨터 전용)
#  - 127.0.0.1 : 외부 기기 접속 불가 (기본값, 안전)
#  - 0.0.0.0   : 같은 와이파이 폰/태블릿 접속 허용 ("외부접속 전환.app"으로 변경됨)
# 환경변수 HOLY_HOST가 settings.env보다 우선 (개발자 수동 지정용)
SETTINGS="$ROOT/backend/settings.env"
if [ -f "$SETTINGS" ] && [ -z "${HOLY_HOST:-}" ]; then
  # settings.env 의 HOLY_HOST=... 줄만 읽음 (주석/공백 무시)
  SAVED_HOST=$(grep -E '^HOLY_HOST=' "$SETTINGS" | tail -1 | cut -d'=' -f2- | tr -d '[:space:]')
  [ -n "$SAVED_HOST" ] && export HOLY_HOST="$SAVED_HOST"
fi
HOST="${HOLY_HOST:-127.0.0.1}"

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

echo "🎤 Practice Machine by SHY 시작 → http://localhost:$PORT (바인딩: $HOST)"
cd "$ROOT/backend"
source venv/bin/activate

# 백그라운드 실행 (기본) or 포그라운드 (HOLY_FOREGROUND=1)
if [ "${HOLY_FOREGROUND:-}" = "1" ]; then
  exec python -m uvicorn main:app --host "$HOST" --port "$PORT"
else
  LOG="$ROOT/backend/run.log"
  nohup python -m uvicorn main:app --host "$HOST" --port "$PORT" >"$LOG" 2>&1 &
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
