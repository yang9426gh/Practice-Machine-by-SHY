#!/usr/bin/env bash
# Practice Machine by SHY — 원클릭 스마트 런처
# .app 더블클릭 → 필요한 것 전부 자동 설치 → 서버 기동 → 브라우저 오픈
#
# v1.4.2:
#   - 내장 Python 런타임 URL 복구 (이전 빌드는 URL이 손상돼 폴백 다운로드가 항상 실패)
#   - node 없어도 자동 설치 (공식 tarball → runtime/node, 비밀번호 불필요)
#     (yt-dlp의 YouTube JS challenge가 node 런타임을 요구 — 없으면 일부 영상 다운로드 실패)
#   - 임시파일 경로 유니크화 (동시실행 충돌 방지)
#
# 모든 구성요소는 이 폴더 안에 설치됨 → 제거 시 폴더 삭제로 끝 (시스템 오염 없음)
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"
LOG="$ROOT/launcher.log"
PBS_TAG="20241016"           # python-build-standalone release tag
NODE_VER="v22.14.0"          # LTS — 프론트 빌드물은 패키지에 포함되어 있어
                             # node는 yt-dlp JS challenge 전용

say() { osascript -e "display notification \"${1//\"/}\" with title \"Practice Machine by SHY\"" 2>/dev/null; }
dialog() { osascript -e "display dialog \"${1//\"/}\" with title \"Practice Machine by SHY\" buttons {\"OK\"} default button 1 with icon note" >/dev/null 2>&1; }

# Finder/launchd 실행 시 PATH가 /usr/bin:/bin 뿐 — Homebrew(node, ffmpeg 등) 접근 보장
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ---------- 0) 읽기전용 위치(DMG 등)에서 실행되면 바탕화면으로 복사 후 재실행 ----------
# v1.6.1: DMG를 마운트한 채 앱을 실행하면 venv/런타임/로그 생성이 전부 실패(Read-only file system).
if [ ! -w "$ROOT" ]; then
  osascript -e 'display dialog "DMG에서 바로 실행했습니다.\n바탕화면으로 복사한 뒤 자동으로 계속합니다." with title "Practice Machine by SHY" buttons {"OK"} default button 1 with icon note giving up after 15' >/dev/null 2>&1 || true
  DEST="$HOME/Desktop/Practice Machine by SHY"
  if [ -e "$DEST" ]; then
    # v1.7.0: 기존 설치 발견 → 업데이트 모드 (곡 데이터·설정 보존, 코드만 교체)
    BAK="$DEST (이전백업 $(date +%Y%m%d-%H%M))"
    mv "$DEST" "$BAK" || { dialog "기존 폴더를 옮기지 못했습니다. 앱·서버를 종료한 뒤 다시 실행해주세요."; open -R "$DEST"; exit 0; }
    if ! ditto "$ROOT" "$DEST"; then mv "$BAK" "$DEST"; dialog "복사 실패 — 원래 폴더를 그대로 되돌렸습니다."; exit 1; fi
    chmod -R u+w "$DEST" 2>/dev/null || true
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
    [ -f "$BAK/backend/run.pid" ] && kill "$(cat "$BAK/backend/run.pid")" 2>/dev/null || true
    command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
    for i in 1 2 3 4 5 6; do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" || break; sleep 0.5; done
    for item in backend/data backend/venv backend/runtime backend/settings.env backend/run.log backend/run.err backend/run.pid launcher.log toggle.log; do
      if [ -e "$BAK/$item" ] && [ ! -e "$DEST/$item" ]; then mv "$BAK/$item" "$DEST/$item" 2>/dev/null || true; fi
    done
    rm -rf "$BAK"
    say "업데이트 완료 — 곡 데이터를 그대로 옮겼습니다"
    if [ "${HOLY_MIGRATE_TEST:-}" = "1" ]; then echo "[test] migrate ok: $DEST"; echo "[test] data: $(ls "$DEST/backend/data" 2>/dev/null | head -3 | tr '\n' ' ')"; exit 0; fi
    APP="$DEST/Practice Machine by SHY.app"
    if [ -d "$APP" ]; then open "$APP"; else exec bash "$DEST/install.sh"; fi
    exit 0
  fi
  ditto "$ROOT" "$DEST" || { dialog "바탕화면 복사 실패.\nDMG의 폴더를 직접 드래그해서 옮긴 뒤 실행해 주세요."; exit 1; }
  chmod -R u+w "$DEST" 2>/dev/null || true
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  say "바탕화면 복사 완료 — 설치를 계속합니다"
  if [ "${HOLY_RELOCATE_TEST:-}" = "1" ]; then echo "[test] relocate ok: $DEST"; ls "$DEST" | head -6; exit 0; fi
  APP="$DEST/Practice Machine by SHY.app"
  if [ -d "$APP" ]; then open "$APP"; else exec bash "$DEST/launcher.sh"; fi
  exit 0
fi

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%F %T') launcher start ==="

TMP_TGZ="$(mktemp -t pmdownload).tar.gz"
trap 'rm -f "$TMP_TGZ"' EXIT

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
  # python-build-standalone 폴백 (repo 내부에 설치 → self-contained 유지)
  echo "Python 3.10+ 없음 — 내장 런타임 다운로드 (1회, 약 60MB)"
  say "Python 런타임 다운로드 중... (1회)"
  ARC="aarch64"; [ "$(uname -m)" = "x86_64" ] && ARC="x86_64"
  URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-3.11.10%2B${PBS_TAG}-${ARC}-apple-darwin-install_only.tar.gz"
  mkdir -p "$ROOT/runtime"
  if curl -sL "$URL" -o "$TMP_TGZ" && tar -xzf "$TMP_TGZ" -C "$ROOT/runtime" 2>/dev/null; then
    PY="$ROOT/runtime/python/bin/python3"
    say "Python 런타임 준비 완료"
  else
    dialog "Python 설치에 실패했습니다.\n인터넷 연결을 확인하거나 python.org에서 Python을 설치해주세요."
    exit 1
  fi
fi
echo "python: $PY ($("$PY" --version 2>&1))"

# ---------- 3) node 확보 (yt-dlp JS challenge용; 프론트 빌드는 패키지에 포함) ----------
NODE=""
for c in node "$ROOT/runtime/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$c" ] || command -v "$c" >/dev/null 2>&1 || continue
  NODE="$c"; break
done
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  newest=$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)
  [ -n "$newest" ] && [ -x "$HOME/.nvm/versions/node/$newest/bin/node" ] && \
    NODE="$HOME/.nvm/versions/node/$newest/bin/node"
fi
if [ -z "$NODE" ]; then
  echo "node 없음 — 내장 node 다운로드 (1회, 약 25MB)"
  say "node 런타임 다운로드 중... (1회)"
  # 주의: nodejs.org tarball 이름은 arm64/x64 (aarch64/x86_64 아님!)
  NARC="arm64"; [ "$(uname -m)" = "x86_64" ] && NARC="x64"
  NURL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${NARC}.tar.gz"
  mkdir -p "$ROOT/runtime"
  if curl -sL "$NURL" -o "$TMP_TGZ" && tar -xzf "$TMP_TGZ" -C "$ROOT/runtime" 2>/dev/null; then
    rm -rf "$ROOT/runtime/node" 2>/dev/null
    if mv "$ROOT/runtime/node-${NODE_VER}-darwin-${NARC}" "$ROOT/runtime/node" 2>/dev/null && [ -x "$ROOT/runtime/node/bin/node" ]; then
      NODE="$ROOT/runtime/node/bin/node"
      say "node 준비 완료"
    else
      NODE=""
    fi
    if [ -z "$NODE" ]; then
      echo "경고: node 설치 실패 — 일부 YouTube 영상이 다운로드되지 않을 수 있음"
    fi
  else
    # node는 필수는 아님 — 일부 영상(JS challenge)만 실패. 경고 후 계속.
    echo "경고: node 다운로드 실패 — 일부 YouTube 영상이 다운로드되지 않을 수 있음"
  fi
fi
echo "node: ${NODE:-(없음 — JS challenge 영상 제한)}"
# 백엔드 processor.find_node()가 이 경로를 못 찾는 경우 대비해 환경변수로 힌트
if [ -n "$NODE" ]; then
  export HOLY_YTDLP_JS_RUNTIMES="node:$NODE"
fi

# ---------- 4) 의존성 설치 (최초 1회) ----------
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

# ---------- 5) 프론트 빌드물 확인 (패키지에 포함됨) ----------
if [ ! -f "$ROOT/frontend/out/index.html" ]; then
  dialog "프론트엔드 빌드물이 없습니다.\n패키지를 다시 다운로드해주세요."
  exit 1
fi

# ---------- 6) 서버 기동 ----------
DATA_DIR="${HOLY_DATA_DIR:-$ROOT/backend/data}"
mkdir -p "$DATA_DIR"
export HOLY_DATA_DIR="$DATA_DIR"
cd "$ROOT/backend"
# settings.env 에 저장된 바인딩(외부접속 토글 결과) 존중 — 없으면 127.0.0.1 (이 컴퓨터 전용)
if [ -f settings.env ]; then
  SAVED_HOST=$(grep -E '^HOLY_HOST=' settings.env | tail -1 | cut -d'=' -f2- | tr -d '[:space:]')
  [ -n "$SAVED_HOST" ] && export HOLY_HOST="$SAVED_HOST"
fi
export HOLY_HOST="${HOLY_HOST:-127.0.0.1}"
nohup "$ROOT/backend/venv/bin/python" -m uvicorn main:app --host "$HOLY_HOST" --port "$PORT" \
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
