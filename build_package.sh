#!/usr/bin/env bash
# 원클릭 배포 패키지 빌드 (DMG + zip):
#   Holy Karaoke Stems.app        (더블클릭 = 설치+실행)
#   Holy Karaoke Stems 종료.app   (더블클릭 = 서버 종료)
#   Holy Karaoke Stems 제거.app   (더블클릭 = 언인스톨)
# + 프론트 빌드물(frontend/out) 포함 → 받는 맥에 Node 불필요
#
# v1.2 변경:
#   - .app이 스스로 상대경로로 프로젝트 루트를 찾음 (어디에 풀어도/옮겨도 동작)
#     [빌드머신 절대경로 하드코딩 버그 수정 — v1.1 패키지는 다른 맥에서 동작 안 함]
#   - 앱 아이콘 (assets/app.icns, make_icon.py로 생성)
#   - DMG 배포 (더블클릭 → 폴더 열림 → 안내대로 드래그/실행) + zip 백업
#   - 프론트 항상 재빌드 (최신 기능 포함 보장)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
VERSION="1.4.0"
STAGE="$(mktemp -d)"
DMG_DIR="$STAGE/dmg"
APPDIR="$DMG_DIR/Holy Karaoke Stems"   # 배포 폴더 = 프로젝트 루트 (앱들이 그 안에 위치)
OUT="$ROOT/dist"
mkdir -p "$OUT"

trap 'rm -rf "$STAGE"' EXIT

echo "🏗️  프론트 빌드 (항상 최신)..."
(cd frontend && npm run build >/dev/null 2>&1)

make_app() { # $1=앱이름 $2=실행스크립트(프로젝트 루트 기준 상대경로)
  local app="$APPDIR/$1.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleDisplayName</key><string>$1</string>
  <key>CFBundleIdentifier</key><string>local.holykaraoke.$VERSION.$3</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
  # 상대경로 해석: run ← App.app/Contents/MacOS/ → 3단계 위 = 앱이 있는 폴더 = 프로젝트 루트
  cat > "$app/Contents/MacOS/run" <<EOF
#!/usr/bin/env bash
DIR="\$(cd "\$(dirname "\$0")/../../.." && pwd)"
exec "\$DIR/$2"
EOF
  chmod +x "$app/Contents/MacOS/run"
  if [ -f "$ROOT/assets/app.icns" ]; then
    cp "$ROOT/assets/app.icns" "$app/Contents/Resources/app.icns"
  fi
}

echo "📦 프로젝트 복사..."
mkdir -p "$APPDIR"
rsync -a \
  --exclude 'backend/venv' --exclude 'backend/data' --exclude 'backend/run.log' --exclude 'backend/run.pid' \
  --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'frontend/node_modules' --exclude 'frontend/.next' \
  --exclude '.git' --exclude 'runtime' --exclude 'dist' --exclude 'launcher.log' \
  --exclude '.DS_Store' --exclude 'assets' --exclude 'make_icon.py' --exclude 'build_package.sh' \
  "$ROOT/" "$APPDIR/"

echo "🔧 .app 번들 생성..."
make_app "Holy Karaoke Stems" "launcher.sh" "start"
make_app "Holy Karaoke Stems 종료" "stop.sh" "stop"
make_app "Holy Karaoke Stems 제거" "uninstall.sh" "uninstall"
make_app "Holy Karaoke Stems 로그" "view_log.sh" "log"
make_app "Holy Karaoke Stems 외부접속 전환" "toggle_external.sh" "toggle"

cat > "$APPDIR/! 먼저 읽으세요.txt" <<'EOF'
🎤 Holy Karaoke Stems — 설치/사용 안내

1. 이 폴더("Holy Karaoke Stems") 전체를 원하는 위치로 옮기세요.
   (응용프로그램·문서·바탕화면 아무 곳이나 OK — 폴더 안의 앱들이 서로를 자동으로 찾습니다)

2. 폴더 안에서 "Holy Karaoke Stems" 앱을 더블클릭하세요.
   · 첫 실행: 필요한 구성요소를 자동 내려받아 설치합니다 (인터넷 필요, 몇 분 소요).
   · 이후 실행: 서버가 켜지고 브라우저가 자동으로 열립니다 (http://localhost:8011).

3. 서버 끄기:  "Holy Karaoke Stems 종료" 앱 더블클릭
4. 완전 삭제:  "Holy Karaoke Stems 제거" 앱 더블클릭 (곡 데이터 포함 삭제)
5. 에러 확인:  "Holy Karaoke Stems 로그" 앱 더블클릭 — 서버 로그가 콘솔 앱에서 실시간 표시됩니다
   (에러가 났으면 이 로그를 복사해서 공유하면 됩니다)

6. 폰·태블릿에서 부르기: "Holy Karaoke Stems 외부접속 전환" 앱 더블클릭
   · 한 번 실행: 외부접속 켜짐 — 같은 와이파이 기기에서 http://<이 맥 IP>:8011 접속 (IP는 팝업에 표시)
   · 다시 한 번 실행: 외부접속 꺼짐 — 이 컴퓨터에서만 접속 (기본 상태)

※ 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면 (macOS 보안 정책):
   시스템 설정 → 개인정보 보호 및 보안 → 맨 아래 "확인 없이 열기" 버튼 클릭
   → 이후부터는 더블클릭만으로 실행됩니다.

※ 저작권 안내: 본 프로그램은 개인 연습 목적의 도구입니다.
   사용자는 각자 관할 법률과 플랫폼 약관을 준수할 책임이 있으며,
   다운로드한 음원의 권리는 원 저작권자에게 있습니다. 영리 목적으로 사용하지 마세요.
EOF
cp "$APPDIR/! 먼저 읽으세요.txt" "$DMG_DIR/설치 안내.txt"

echo "🗜️  zip 생성..."
(cd "$DMG_DIR" && zip -qry "$OUT/holy-karaoke-stems-v$VERSION-oneclick.zip" "Holy Karaoke Stems")

echo "💿 DMG 생성..."
hdiutil create -volname "Holy Karaoke Stems" -srcfolder "$DMG_DIR" -ov -format UDZO \
  "$OUT/Holy-Karaoke-Stems-v$VERSION.dmg" >/dev/null

echo ""
ls -lh "$OUT"
echo "✅ 완료: $OUT/Holy-Karaoke-Stems-v$VERSION.dmg (배포용) / holy-karaoke-stems-v$VERSION-oneclick.zip (백업)"
