#!/usr/bin/env bash
# 코드 전용 업데이트 zip + manifest 생성 (v1.7.0 원클릭 자가 업데이트용)
#
# 사용: ./build_update_zip.sh
# 산출: dist/update-v<VERSION>.zip + dist/update-manifest.json
#  - zip은 곡 데이터(backend/data), venv, 런타임, 로그, settings.env를 "절대" 포함하지 않는다
#  - manifest의 zip_file_id는 tools/publish_update.py가 최초 업로드 후 채운다 (이후 FID 불변)
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('frontend/package.json'))['version'])")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/backend" "$STAGE/frontend"
cp backend/*.py backend/requirements.txt "$STAGE/backend/"
rsync -a --delete frontend/out/ "$STAGE/frontend/out/"
cp frontend/package.json "$STAGE/frontend/"
cp launcher.sh install.sh run.sh uninstall.sh "$STAGE/"
cp README*.txt README*.md "$STAGE/" 2>/dev/null || true
cp windows_*.ps1 "$STAGE/" 2>/dev/null || true
cp *.bat "$STAGE/" 2>/dev/null || true
echo "$VERSION" > "$STAGE/VERSION"

OUT_ABS="$(pwd)/dist/update-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT_ABS"
(cd "$STAGE" && zip -rq "$OUT_ABS" .)
SHA=$(shasum -a 256 "$OUT_ABS" | awk '{print $1}')

cat > dist/update-manifest.json <<EOF
{
  "version": "$VERSION",
  "zip_file_id": "ZIP_FILE_ID_PLACEHOLDER",
  "sha256": "$SHA",
  "released_at": "$(date '+%F')",
  "notes": ""
}
EOF

ls -lh "$OUT_ABS"
echo "sha256: $SHA"
echo "manifest: dist/update-manifest.json (버전 $VERSION)"
echo "다음: python3 tools/publish_update.py --notes \"...\" [--zip-id FID] [--manifest-id FID]"
