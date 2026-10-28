#!/usr/bin/env bash
# Holy Karaoke Stems — 외부접속(같은 와이파이 기기) 켜기/끄기 토글
#   켜기: 서버를 0.0.0.0 으로 재시작 (폰/태블릿에서 접속 가능)
#   끄기: 서버를 127.0.0.1 로 재시작 (이 컴퓨터 전용, 기본값)
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
PORT="${HOLY_PORT:-8011}"
SETTINGS="$ROOT/backend/settings.env"
LOG="$ROOT/toggle.log"

say() { osascript -e "display notification \"${1//\"/}\" with title \"Holy Karaoke Stems\"" 2>/dev/null; }
# dialog: OK 클릭 없으면 120초 후 자동 닫힘 (giving up after) — 뜬채로 멈추지 않게
dialog() { osascript -e "display dialog \"${1//\"/}\" with title \"Holy Karaoke Stems\" buttons {\"OK\"} default button 1 with icon note giving up after 120" >/dev/null 2>&1; }

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%F %T') toggle start ==="

current_host() {
  [ -f "$SETTINGS" ] && grep -E '^HOLY_HOST=' "$SETTINGS" | tail -1 | cut -d'=' -f2- | tr -d '[:space:]' || true
}

CUR=$(current_host)
if [ "$CUR" = "0.0.0.0" ]; then
  MODE="off"
  NEW="127.0.0.1"
  MSG="외부접속을 껐습니다.\n이 컴퓨터에서만 접속됩니다."
else
  MODE="on"
  NEW="0.0.0.0"
fi

# settings.env 저장
mkdir -p "$(dirname "$SETTINGS")"
if [ -f "$SETTINGS" ]; then
  if grep -qE '^HOLY_HOST=' "$SETTINGS"; then
    sed -i '' "s|^HOLY_HOST=.*|HOLY_HOST=$NEW|" "$SETTINGS"
  else
    echo "HOLY_HOST=$NEW" >> "$SETTINGS"
  fi
else
  echo "HOLY_HOST=$NEW" > "$SETTINGS"
fi
echo "settings.env: HOLY_HOST=$NEW"

# 서버 재시작 (run.sh가 settings.env를 읽음)
bash "$ROOT/run.sh"
RC=$?
if [ $RC -ne 0 ]; then
  dialog "서버 재시작 실패 — $ROOT/backend/run.log 확인"
  exit 1
fi

if [ "$MODE" = "on" ]; then
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
  if [ -n "$IP" ]; then
    say "외부접속 켜짐: http://$IP:$PORT"
    dialog "외부접속이 켜졌습니다.\n\n같은 와이파이 기기에서 접속:\nhttp://$IP:$PORT\n\n끄려면 이 앱을 다시 실행하세요."
  else
    say "외부접속 켜짐 (포트 $PORT)"
    dialog "외부접속이 켜졌습니다.\n\n같은 와이파이 기기에서 접속:\nhttp://<이 컴퓨터 IP>:$PORT\n(시스템설정→Wi‑Fi에서 IP 확인)\n\n끄려면 이 앱을 다시 실행하세요."
  fi
else
  say "외부접속 꺼짐"
  dialog "외부접속을 껐습니다.\n이 컴퓨터에서만 접속됩니다."
fi
