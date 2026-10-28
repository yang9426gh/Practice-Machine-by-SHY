#!/usr/bin/env bash
# Practice Machine by SHY — 언인스톨
#
# 사용:
#   ./uninstall.sh              # 대화형 (질문에 y/n — 엔터=안전 기본값)
#   ./uninstall.sh --keep-data  # 앱·캐시만 제거, 곡 데이터(backend/data) 보존
#   ./uninstall.sh --all        # 전부 삭제 — 곡·스템·DB 포함, 되돌릴 수 없음
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

echo "🎤 Practice Machine by SHY 언인스톨"

# ---------- 1) 실행 중인 서버 종료 ----------
if [ -f backend/run.pid ]; then
  PID="$(cat backend/run.pid 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "↺ 실행 중인 서버 종료 (PID $PID)"
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f backend/run.pid
fi
# pid 파일 없이 떠 있는 경우 대비 — 포트 기반 정리
PORT="${HOLY_PORT:-8011}"
if command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "↺ 포트 $PORT 프로세스 종료"
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

# ---------- 2) 삭제 범위 ----------
MODE="${1:-}"
remove_caches() {
  echo "🧹 캐시·빌드 제거 (venv, node_modules, 빌드물)..."
  rm -rf backend/venv frontend/node_modules frontend/.next frontend/out
  rm -f backend/run.log
}

if [ "$MODE" = "--all" ]; then
  cd ..
  echo "🗑️  폴더 전체 삭제 (곡·스템·DB 포함): $ROOT"
  rm -rf "$ROOT"
  echo "✅ 완전 제거 완료"
  exit 0
fi

if [ "$MODE" = "--keep-data" ]; then
  remove_caches
  echo "📦 사용자 데이터 보존: $ROOT/backend/data"
  echo "✅ 앱 제거 완료 — 재설치는 ./install.sh"
  exit 0
fi

# ---------- 대화형 (플래그 없으면) ----------
# EOF/비대화형 입력 시 빈 답 → 안전 기본값으로 동작 (캐시만 삭제)
read -r -p "캐시·빌드물을 삭제할까요? (venv/node_modules/out) [Y/n]: " A1 || A1=""
if [[ "${A1:-Y}" =~ ^[Yy] ]]; then
  remove_caches
fi

KEEP_DATA=1
if [ -d backend/data ]; then
  SIZE="$(du -sh backend/data 2>/dev/null | cut -f1 || echo "?")"
  read -r -p "곡·스템·라이브러리 데이터(${SIZE})를 삭제할까요? 되돌릴 수 없음 [y/N]: " A2 || A2=""
  if [[ "${A2:-N}" =~ ^[Yy] ]]; then
    rm -rf backend/data
    KEEP_DATA=0
    echo "🗑️  사용자 데이터 삭제됨"
  fi
fi

read -r -p "이 폴더 자체를 삭제할까요? ($ROOT) [y/N]: " A3 || A3=""
if [[ "${A3:-N}" =~ ^[Yy] ]]; then
  if [ "$KEEP_DATA" = "1" ] && [ -d backend/data ]; then
    BACKUP="$HOME/practice-machine-data-backup"
    echo "📦 데이터 보존 이동: $BACKUP"
    rm -rf "$BACKUP"
    mv backend/data "$BACKUP"
  fi
  cd ..
  rm -rf "$ROOT"
  echo "✅ 언인스톨 완료"
else
  echo "✅ 언인스톨 완료 (폴더 유지) — 재설치는 ./install.sh"
fi
