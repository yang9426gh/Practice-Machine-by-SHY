#!/usr/bin/env bash
# 서버 로그(backend/run.log)를 콘솔(Console) 앱으로 열기 — 실시간 갱신 표시
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/backend/run.log"
if [ ! -f "$LOG" ]; then
  /usr/bin/osascript -e 'display dialog "로그 파일이 아직 없습니다.\n먼저 Holy Karaoke Stems 앱을 실행해 주세요." buttons {"확인"} default button 1 with icon note' >/dev/null 2>&1
  exit 0
fi
/usr/bin/open -a Console "$LOG"
