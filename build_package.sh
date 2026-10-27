#!/usr/bin/env bash
# 원클릭 배포 패키지 빌드:
#   Holy Karaoke Stems.app        (더블클릭 = 설치+실행)
#   Holy Karaoke Stems 종료.app   (더블클릭 = 서버 종료)
#   Holy Karaoke Stems 제거.app   (더블클릭 = 언인스톨)
# + 프론트 빌드물(frontend/out) 포함 → 받는 맥에 Node 불필요
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
STAGE="$(mktemp -d)"

echo "🏗️  프론트 빌드 확인/생성..."
if [ ! -f frontend/out/index.html ]; then
  (cd frontend && npm run build >/dev/null 2>&1)
fi

make_app() { # $1=앱이름 $2=스크립트 $3=아이콘문자
  local app="$STAGE/$1.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleDisplayName</key><string>$1</string>
  <key>CFBundleIdentifier</key><string>local.holykaraoke.$3</string>
  <key>CFBundleVersion</key><string>1.1.0</string>
  <key>CFBundleShortVersionString</key><string>1.1.0</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
  cat > "$app/Contents/MacOS/run" <<EOF
#!/usr/bin/env bash
"$ROOT/$2"
EOF
  chmod +x "$app/Contents/MacOS/run"
}

make_app "Holy Karaoke Stems" "launcher.sh" "start"
make_app "Holy Karaoke Stems 종료" "stop.sh" "stop"
make_app "Holy Karaoke Stems 제거" "uninstall.sh" "uninstall"

echo "📦 tarball 구성..."
TARBALL="$STAGE/holy-karaoke-stems-v1.1-oneclick.tar.gz"
tar --exclude='backend/venv' --exclude='backend/data' --exclude='backend/run.log' --exclude='backend/run.pid' \
    --exclude='frontend/node_modules' --exclude='frontend/.next' --exclude='runtime' \
    --exclude='.DS_Store' --exclude='launcher.log' --exclude='dist' \
    -czf "$TARBALL" \
    -C "$ROOT" \
    backend frontend install.sh run.sh uninstall.sh launcher.sh stop.sh README.md .gitignore \
    -C "$STAGE" "Holy Karaoke Stems.app" "Holy Karaoke Stems 종료.app" "Holy Karaoke Stems 제거.app"

OUT="$ROOT/dist"
mkdir -p "$OUT"
cp "$TARBALL" "$OUT/"
ls -lh "$OUT"
echo "✅ 완료: $OUT/$(basename "$TARBALL")"
