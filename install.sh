#!/usr/bin/env bash
# Practice Machine by SHY — 터미널 설치 스크립트 (최초 1회)
#
# v1.4.2: 빠진 것을 자동으로 설치한다 (기존엔 ❌ 메시지만 띄우고 종료)
#   - Python 3.10+ 없음 → Homebrew로 python@3.12 (brew 있을 때)
#                       → 없으면 공식 standalone 런타임을 runtime/ 에 (비밀번호 불필요)
#   - node 없음        → Homebrew로 node (brew 있을 때)
#                       → 없으면 공식 tarball을 runtime/node 에 (비밀번호 불필요)
#   - ffmpeg 불필요    → imageio-ffmpeg이 pip로 자동 설치됨 (yt-dlp에 경로 전달까지 코드 처리)
#
# 참고: brew가 아예 없는 맥에서의 sudo Homebrew 설치는 비밀번호 입력이 필요해서
#       스크립트가 대신해주지 않는다. 그 경우에도 위 폴백 경로로 전부 자동 설치되므로
#       이 스크립트는 sudo/비밀번호 없이 끝까지 돌아간다.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

# ---------- 0) 읽기전용 위치(DMG 등)에서 실행되면 바탕화면으로 복사 후 재실행 ----------
# v1.6.1: DMG를 마운트한 채 그 안에서 실행하면 venv/런타임/로그 생성이 전부
#         "Read-only file system"으로 실패함(실측: /Volumes 경로 직접 실행). 자동 복구.
if [ ! -w "$ROOT" ]; then
  osascript -e 'display dialog "DMG에서 바로 실행했습니다.\n바탕화면으로 복사한 뒤 자동으로 계속합니다." with title "Practice Machine by SHY" buttons {"OK"} default button 1 with icon note giving up after 15' >/dev/null 2>&1 || true
  DEST="$HOME/Desktop/Practice Machine by SHY"
  if [ -e "$DEST" ]; then
    osascript -e 'display dialog "바탕화면에 이미 폴더가 있습니다.\n그 폴더 안의 Practice Machine by SHY 앱을 실행해 주세요." with title "Practice Machine by SHY" buttons {"OK"} default button 1 with icon note giving up after 15' >/dev/null 2>&1 || true
    open -R "$DEST"
    exit 0
  fi
  ditto "$ROOT" "$DEST" || { echo "❌ 바탕화면 복사 실패 — DMG의 폴더를 직접 드래그해서 옮긴 뒤 실행해 주세요."; exit 1; }
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  echo "✔ 바탕화면으로 복사 완료 — 설치를 계속합니다"
  if [ "${HOLY_RELOCATE_TEST:-}" = "1" ]; then echo "[test] relocate ok: $DEST"; ls "$DEST" | head -6; exit 0; fi
  APP="$DEST/Practice Machine by SHY.app"
  if [ -d "$APP" ]; then open "$APP"; else exec bash "$DEST/install.sh"; fi
  exit 0
fi

echo "🎤 Practice Machine by SHY 설치"

# Finder에서 연 터미널은 PATH가 좁을 수 있음 — Homebrew 보장
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# brew가 PATH에 없지만 /opt/homebrew/bin/brew가 존재하면 셸 설정이 안 된 것
# (설치 직후 새 터미널을 안 열면 brew를 못 찾는 함정 — 로그 실측)
if ! command -v brew >/dev/null 2>&1 && [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
if ! command -v brew >/dev/null 2>&1 && [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

TMP_TGZ="$(mktemp -t pminstall).tar.gz"
trap 'rm -f "$TMP_TGZ"' EXIT

# ---------- Python ----------
PYTHON_BIN=""
for cand in "${PYTHON_BIN_OVERRIDE:-}" "$ROOT/runtime/python/bin/python3" python3.13 python3.12 python3.11 python3; do
  [ -z "$cand" ] && continue
  if [ -x "$cand" ] || command -v "$cand" >/dev/null 2>&1; then
    v=$("$cand" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || echo "0")
    major=${v%%.*}; minor=${v##*.}
    if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ] 2>/dev/null; then
      PYTHON_BIN="$cand"; break
    fi
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  ARC="aarch64"; [ "$(uname -m)" = "x86_64" ] && ARC="x86_64"
  if command -v brew >/dev/null 2>&1; then
    echo "📦 Python 없음 — Homebrew로 설치 중..."
    brew install python@3.12
    export PATH="/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    PYTHON_BIN="python3.12"
    command -v "$PYTHON_BIN" >/dev/null 2>&1 || PYTHON_BIN="python3"
  else
    echo "📦 Python 없고 Homebrew도 없음 — 공식 런타임 다운로드 (이 폴더 안에 설치, 비밀번호 불필요)"
    URL="https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10%2B20241016-${ARC}-apple-darwin-install_only.tar.gz"
    mkdir -p "$ROOT/runtime"
    curl -fL "$URL" -o "$TMP_TGZ"
    tar -xzf "$TMP_TGZ" -C "$ROOT/runtime"
    PYTHON_BIN="$ROOT/runtime/python/bin/python3"
  fi
fi
echo "✔ python: $("$PYTHON_BIN" --version) ($PYTHON_BIN)"

# ---------- node ----------
NODE=""
for cand in node "$ROOT/runtime/node/bin/node"; do
  if [ -x "$cand" ] || command -v "$cand" >/dev/null 2>&1; then NODE="$cand"; break; fi
done
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  newest=$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)
  [ -n "$newest" ] && [ -x "$HOME/.nvm/versions/node/$newest/bin/node" ] && \
    NODE="$HOME/.nvm/versions/node/$newest/bin/node"
fi

if [ -z "$NODE" ]; then
  ARC="arm64"; [ "$(uname -m)" = "x86_64" ] && ARC="x64"
  if command -v brew >/dev/null 2>&1; then
    echo "📦 node 없음 — Homebrew로 설치 중..."
    brew install node
    NODE="node"
  else
    echo "📦 node 없고 Homebrew도 없음 — 공식 tarball 다운로드 (이 폴더 안에 설치, 비밀번호 불필요)"
    # 주의: nodejs.org tarball 이름은 arm64/x64 (aarch64/x86_64 아님!)
    NARC="arm64"; [ "$(uname -m)" = "x86_64" ] && NARC="x64"
    NURL="https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-${NARC}.tar.gz"
    mkdir -p "$ROOT/runtime"
    curl -fL "$NURL" -o "$TMP_TGZ"
    tar -xzf "$TMP_TGZ" -C "$ROOT/runtime"
    rm -rf "$ROOT/runtime/node"
    mv "$ROOT/runtime/node-v22.14.0-darwin-${NARC}" "$ROOT/runtime/node"
    NODE="$ROOT/runtime/node/bin/node"
  fi
fi
echo "✔ node $("$NODE" --version)"

# ---------- 백엔드 venv ----------
cd "$ROOT/backend"
if [ ! -x venv/bin/python ]; then
  echo "📦 Python venv 생성..."
  "$PYTHON_BIN" -m venv venv
fi
source venv/bin/activate
echo "📦 Python 의존성 설치 (몇 분 소요)..."
pip install --quiet --upgrade pip wheel
pip install --quiet -r requirements.txt
echo "✔ 백엔드 의존성 완료 (ffmpeg 포함 — 별도 설치 불필요)"

# ---------- 프론트엔드 ----------
cd "$ROOT/frontend"
if [ ! -d node_modules ]; then
  echo "📦 프론트엔드 의존성 설치..."
  "$NODE" "$(command -v npm || echo "$ROOT/runtime/node/bin/npm")" install --no-fund --no-audit
fi
echo "🏗️  프론트엔드 정적 빌드..."
NPM="$(command -v npm || echo "$ROOT/runtime/node/bin/npm")"
"$NODE" "$NPM" run build
echo "✔ 프론트엔드 빌드 완료 (frontend/out/)"

echo ""
echo "✅ 설치 완료! 실행: ./run.sh  →  http://localhost:8011"
echo "   (또는 'Practice Machine by SHY' 앱 더블클릭)"
