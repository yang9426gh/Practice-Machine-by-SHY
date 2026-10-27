#!/usr/bin/env bash
# Holy Karaoke Stems — 원클릭 스마트 런처
# .app 더블클릭 → 필요하면 자동 설치 → 서버 기동 → 브라우저 오픈
#   환경: 최초 1회 venv+의존성 설치 (몇 분), 이후는 즉시 기동
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"
LOG="$ROOT/launcher.log"

say() { osascript -e "display notification \"${1//\"/}\" with title \"Holy Karaoke Stems\"" 2>/dev/null; }
dialog() { osascript -e "display dialog \"${1//\"/}\" with title \"Holy Karaoke Stems\" buttons {\"OK\"} default button 1 with icon note" >/dev/null 2>&1; }

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%F %T') launcher start ==="

# ---------- 1) 이미 실행 중이면 브라우저만 열고 끝 ----------
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
  open "http://localhost:$PORT"
  exit 0
fi

# ---------- 2) Python 확보 ----------
PY=""
for c in "$ROOT/runtime/python/bin/python3" python3.13 python3.12 python3.11 python3; do
  [ -x "$c" ] || command -v "$c" >/dev/null 2>&1 || continue
  v=$("$c" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || echo 0)
  maj=${v%%.*}; min=${v##*.}
  if [ "$maj" = "3" ] && [ "$min" -ge 10 ] 2>/dev/null; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "Python 3.10+ 없음 — 내장 런타임 다운로드 (1회, 약 60MB)"
  say "Python 런타임 다운로드 중... (1회)"
  ARC="aarch64"; [ "$(uname -m)" = "x86_64" ] && ARC="x86_64"
  URL="https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-${ARC}-apple-darwin-install_only.tar.gz"
  mkdir -p "$ROOT/runtime"
  if curl -sL "$URL" -o /tmp/holy_py.tar.gz && tar -xzf /tmp/holy_py.tar.gz -C "$ROOT/runtime" 2>/dev/null; then
    PY="$ROOT/runtime/python/bin/python3"
    say "Python 런타임 준비 완료"
  else
    dialog "Python 설치에 실패했습니다.\n인터넷 연결을 확인하거나 python.org에서 Python을 설치해주세요."
    exit 1
  fi
fi
echo "python: $PY ($("$PY" --version 2>&1))"

# ---------- 3) 의존성 설치 (최초 1회) ----------
cd "$ROOT/backend"
if [ ! -x venv/bin/python ]; then
  say "최초 설치 중... 몇 분 걸려요"
  "$PY" -m venv venv || { dialog "venv 생성 실패"; exit 1; }
fi
source venv/bin/activate
if ! python -c "import fastapi, demucs" >/dev/null 2>&1; then
  echo "의존성 설치 시작 (최초 1회, 몇 분 소요)..."
  pip install --quiet --upgrade pip wheel
  if ! pip install --quiet -r requirements.txt; then
    dialog "의존성 설치 실패 — 인터넷 연결 확인 후 다시 시도해주세요."
    exit 1
  fi
  say "설치 완료!"
fi

# ---------- 4) 프론트 빌드물 확인 (패키지에 포함됨) ----------
if [ ! -f "$ROOT/frontend/out/index.html" ]; then
  dialog "프론트엔드 빌드물이 없습니다.\n패키지를 다시 다운로드해주세요."
  exit 1
fi

# ---------- 5) 서버 기동 ----------
DATA_DIR="${HOLY_DATA_DIR:-$ROOT/backend/data}"
mkdir -p "$DATA_DIR"
export HOLY_DATA_DIR="$DATA_DIR"
cd "$ROOT/backend"
nohup "$ROOT/backend/venv/bin/python" -m uvicorn main:app --host 0.0.0.0 --port "$PORT" \
  >"$ROOT/backend/run.log" 2>&1 &
echo $! > "$ROOT/backend/run.pid"

for i in $(seq 1 40); do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
    say "준비 완료! 브라우저가 열립니다"
    open "http://localhost:$PORT"
    exit 0
  fi
  sleep 0.5
done
dialog "서버 기동 실패 — launcher.log와 backend/run.log를 확인해주세요."
exit 1
