#!/usr/bin/env bash
# Release-verification scaffold — verify the SHIPPED artifact, not the repo.
# Usage:
#   ./verify_release.sh dist/Practice-Machine-by-SHY-v1.6.0-oneclick.zip   # zip 검증
#   ./verify_release.sh /tmp/pm_dmg/"Practice Machine by SHY"              # 마운트된 DMG 폴더 검증
# REPO=/path/to/repo ./verify_release.sh ...  # repo==package 동일성 검사 추가
set -u

# ------- CONFIG (앱마다 수정) -------
SRC="${1:?usage: verify_release.sh <release.zip | unzipped folder>}"
APP_DIR_NAME="Practice Machine by SHY"        # zip 최상위 폴더명
SCRIPTS="install.sh launcher.sh run.sh stop.sh uninstall.sh toggle_external.sh view_log.sh"
APPS=(                                        # 서명 확인할 .app 목록
  "Practice Machine by SHY.app"
  "Practice Machine by SHY 종료.app"
  "Practice Machine by SHY 제거.app"
  "Practice Machine by SHY 외부접속 전환.app"
  "Practice Machine by SHY 로그.app"
)
# 출고물에 절대 있으면 안 되는 패턴 (손상 전파/디버깅 잔재):
BAD_PATTERNS='\*\*\*\*|TODO|FIXME|CHANGE_ME|XXX|/Users/[a-z]+/'
# 최신 픽스 — 패키지가 구버전이 아닌지 확인 (경로:패턴). JS 심볼 grep 금지(미니파이 mangle) — 스크립트/백엔드만:
KEY_FIX_GREPS=(
  "launcher.sh:NARC=\"arm64\""
  "backend/processor.py:--ffmpeg-location"
)
# ------------------------------------

PASS=0; FAIL=0
ok()  { echo "  PASS $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL+1)); }

X=""
case "$SRC" in
  *.zip)
    X="$(mktemp -d "${TMPDIR:-/tmp}/verify_release.XXXXXX")"
    unzip -q "$SRC" -d "$X" || { echo "FAIL zip 해제 불가: $SRC"; exit 1; }
    ROOT="$X/$APP_DIR_NAME" ;;
  *)
    ROOT="$SRC" ;;
esac
[ -d "$ROOT" ] || { echo "FAIL 폴더 없음: $ROOT"; exit 1; }
cleanup() { [ -n "$X" ] && rm -rf "$X"; }
trap cleanup EXIT

echo "== 1) shipped 스크립트 문법 =="
for s in $SCRIPTS; do
  if [ -f "$ROOT/$s" ]; then
    bash -n "$ROOT/$s" && ok "$s bash -n" || bad "$s 문법 오류"
  else
    bad "$s 패키지에서 누락"
  fi
done

echo "== 2) placeholder/손상 패턴 (repo 손상이 package로 전파되지 않았는지) =="
if grep -rInE --include='*.sh' --include='*.py' "$BAD_PATTERNS" "$ROOT" > "${X:-/tmp}/badpat.txt" 2>/dev/null; then
  bad "유해 패턴 발견:"
  sed 's/^/    /' "${X:-/tmp}/badpat.txt" | head -10
else
  ok "스크립트에 placeholder/손상 패턴 없음"
fi

echo "== 3) .app 서명 (무서명 = macOS 15+ 더블클릭 무반응) =="
for a in "${APPS[@]}"; do
  if codesign -dv "$ROOT/$a" 2>&1 | grep -q "Signature="; then
    ok "$a 서명 있음"
  else
    bad "$a 무서명"
  fi
done

echo "== 4) 최신 픽스 포함 여부 (패키지 구버전 검사) =="
for entry in "${KEY_FIX_GREPS[@]}"; do
  f="${entry%%:*}"; p="${entry#*:}"
  if grep -q -e "$p" "$ROOT/$f" 2>/dev/null; then
    ok "$f 에 '$p' 포함"
  else
    bad "$f 에 '$p' 없음 — 패키지가 구버전"
  fi
done

echo "== 5) repo 동일성 (REPO 지정시) =="
if [ -n "${REPO:-}" ] && [ -d "$REPO" ]; then
  for s in $SCRIPTS; do
    if diff -q "$REPO/$s" "$ROOT/$s" >/dev/null 2>&1; then
      ok "repo==package: $s"
    else
      bad "불일치: $s (둘 중 어느 쪽이 최신인지 확인)"
    fi
  done
else
  echo "  (건너뜀 — REPO 환경변수로 repo 경로 지정시 검사)"
fi

echo ""
echo "RESULT: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "VERIFY_RELEASE: ALL GREEN"; else echo "VERIFY_RELEASE: FAILURES"; fi
exit "$FAIL"
