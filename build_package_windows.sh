#!/usr/bin/env bash
# Practice Machine by SHY — Windows 패키지 빌드 (macOS에서 크로스 빌드)
# 산출물: dist/Practice-Machine-by-SHY-v<VERSION>-windows.zip
# ⚠ 이 맥에선 정적 검증만 가능 — 실제 Windows 머신에서 INSTALL/START 실측 필요
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
OUT="$ROOT/dist"
VERSION=$(grep -E '^VERSION="' build_package.sh | cut -d'"' -f2)
APPNAME="Practice Machine by SHY"
STAGE="$OUT/win-stage"

echo "=== Windows 패키지 빌드 v$VERSION ==="
rm -rf "$STAGE"
mkdir -p "$STAGE/$APPNAME"

# 저장소 → 스테이지 (macOS 전용물 제외)
rsync -a \
  --exclude 'backend/venv' --exclude 'backend/data' --exclude 'backend/run.log' --exclude 'backend/run.err' --exclude 'backend/run.pid' \
  --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'frontend/node_modules' --exclude 'frontend/.next' \
  --exclude '.git' --exclude 'runtime' --exclude 'dist' \
  --exclude '.DS_Store' --exclude 'assets' --exclude 'make_icon.py' \
  --exclude 'build_package.sh' --exclude 'build_package_windows.sh' \
  --exclude '*.sh' --exclude '*.app' \
  --exclude 'launcher.log' --exclude 'toggle.log' \
  "$ROOT/" "$STAGE/$APPNAME/"

# 필수 파일 검증
test -f "$STAGE/$APPNAME/INSTALL.bat"
test -f "$STAGE/$APPNAME/START.bat"
test -f "$STAGE/$APPNAME/STOP.bat"
test -f "$STAGE/$APPNAME/TOGGLE_EXTERNAL.bat"
test -f "$STAGE/$APPNAME/UNINSTALL.bat"
test -f "$STAGE/$APPNAME/windows_install.ps1"
test -f "$STAGE/$APPNAME/README-WINDOWS.txt"
test -f "$STAGE/$APPNAME/frontend/out/index.html"
test -f "$STAGE/$APPNAME/backend/main.py"
test -f "$STAGE/$APPNAME/backend/requirements.txt"
echo "✔ 필수 파일 검증 통과"

mkdir -p "$OUT"
(cd "$STAGE" && zip -qry "$OUT/Practice-Machine-by-SHY-v$VERSION-windows.zip" "$APPNAME")
rm -rf "$STAGE"
ls -lh "$OUT/Practice-Machine-by-SHY-v$VERSION-windows.zip"
echo "✅ 완료: dist/Practice-Machine-by-SHY-v$VERSION-windows.zip"
