#!/usr/bin/env bash
# Practice Machine by SHY — 설치 스크립트 (최초 1회)
# 필요: Python 3.10+, Node 18+ (프론트 빌드용)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

echo "🎤 Practice Machine by SHY 설치"

# ---------- 사전 확인 ----------
# 파이썬 선택: 3.10+ 필수 (CLT 구버전 3.9 회피)
PYTHON_BIN=""
for cand in "${PYTHON_BIN_OVERRIDE:-}" python3.13 python3.12 python3.11 python3 python3; do
  [ -z "$cand" ] && continue
  if command -v "$cand" >/dev/null 2>&1; then
    v=$("$cand" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || echo "0")
    major=${v%%.*}; minor=${v##*.}
    if [ "$major" -eq 3 ] && [ "$minor" -ge 10 ] 2>/dev/null; then
      PYTHON_BIN="$cand"; break
    fi
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo "❌ Python 3.10+ 필요 — https://python.org 또는 brew install python@3.12"; exit 1
fi
echo "✔ python: $($PYTHON_BIN --version) ($PYTHON_BIN)"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node 없음 — https://nodejs.org 에서 설치 후 재실행 (프론트 빌드에만 필요)"; exit 1
fi
echo "✔ node $(node --version)"

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
echo "✔ 백엔드 의존성 완료"

# ---------- 프론트엔드 ----------
cd "$ROOT/frontend"
if [ ! -d node_modules ]; then
  echo "📦 프론트엔드 의존성 설치..."
  npm install --no-fund --no-audit
fi
echo "🏗️  프론트엔드 정적 빌드..."
npm run build
echo "✔ 프론트엔드 빌드 완료 (frontend/out/)"

echo ""
echo "✅ 설치 완료! 실행: ./run.sh  →  http://localhost:8011"
