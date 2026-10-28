# Practice Machine by SHY 🎤 v1.1

YouTube 노래를 AI로 스템 분리(보컬/반주/드럼/베이스...)해서 노래방처럼 부르는 앱.

## v1.1 하이라이트

- **가사 · 코드 스트립**: 영상 아래 별도 영역에 표시 (영상을 가리지 않음)
- **가사 가져오기 3가지**: LRCLIB 자동 검색 / LRC 파일 업로드 / 직접 생성
- **싱크 워크플로**: 편집창에서 재생하며 ⏱ 연타 스탬프, 스탬프 클릭=해당 시각 이동
- **코드 편집**: 빈 스탬프 연타(시간 먼저 찍고 코드 나중에 기입), 줄바꿈 버튼
- **트랜스포스트 반응**: 코드 표기가 조(key) 변경에 자동 이동 (품질 표기 m7/dim 등 유지)
- **트랜스포즈 이어듣기**: 조 바꿔도 재생 위치가 유지되고 이어 재생

## 구성

- **backend/** — FastAPI (yt-dlp 다운로드 → Demucs 6스템 분리(MPS 가속) → 키/조 변경 → MP3 익스포트 → SQLite 라이브러리·프리셋)
- **frontend/** — Next.js (정적 익스포트, FastAPI가 직접 서빙)

## 설치 & 실행

```bash
./install.sh   # 최초 1회: venv + 의존성 + 프론트 빌드
./run.sh       # 백엔드+프론트 단일 프로세스 실행 → http://localhost:8011
```

필요: macOS(Apple Silicon 권장), Python 3.10+, Node 18+ (빌드시에만)

- ffmpeg는 자동 다운로드(imageio-ffmpeg) — Homebrew 불필요
- 같은 네트워크 기기에서 접속: `http://<이 Mac의 IP>:8011` (기본 `HOLY_HOST=0.0.0.0`)
- 종료: `kill $(cat backend/run.pid)` (또는 포트 8011 프로세스 종료)

## 제거 (언인스톨)

```bash
./uninstall.sh              # 대화형 — 캐시/데이터/폴더를 하나씩 물어봄
./uninstall.sh --keep-data  # 앱·캐시만 제거, 곡 데이터 보존 (재설치 시 그대로 복원)
./uninstall.sh --all        # 전부 삭제 (곡·스템·DB 포함 — 되돌릴 수 없음)
```

앱은 외부 시스템 영역에 아무것도 설치하지 않으므로 폴더 삭제만으로 완전 제거됩니다.
`--keep-data`로 지우면 다음 `./install.sh` 때 곡·라이브러리가 그대로 유지됩니다.

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLY_PORT` | `8011` | 서버 포트 |
| `HOLY_HOST` | `127.0.0.1` | `0.0.0.0`로 바꾸면 같은 네트워크 기기 접속 허용 ("외부접속 전환" 앱 또는 `backend/settings.env`) |
| `HOLY_DATA_DIR` | `backend/data` | 다운로드/스템/DB 저장 위치 |

## 외부접속 (폰·태블릿에서 부르기)

기본은 **이 컴퓨터 전용**(127.0.0.1) — 외부에서 접속 불가.

- 원클릭 앱: **"Practice Machine by SHY 외부접속 전환"** 더블클릭 = 켜기/끄기 토글
  (켜면 같은 와이파이 기기에서 `http://<맥 IP>:8011` 접속, IP는 팝업에 표시)
- 수동: `backend/settings.env`에 `HOLY_HOST=0.0.0.0` 저장 후 서버 재시작

### 기타 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLY_DEMUCS_MODEL` | `htdemucs_6s` | Demucs 모델 |
| `HOLY_YTDLP_COOKIES_FROM_BROWSER` | (없음) | chrome/firefox/safari — 연령제한 영상용 |
| `HOLY_FFMPEG` | 자동탐색 | ffmpeg 경로 |
| `HOLY_FOREGROUND` | (없음) | `1` = 포그라운드 실행 (디버깅용) |

## 저작권 안내

본 프로그램은 개인 연습 목적의 도구입니다. 사용자는 각자 관할 법률과 플랫폼 약관을
준수할 책임이 있으며, 다운로드한 음원의 권리는 원 저작권자에게 있습니다.
영리 목적으로 사용하지 마세요.

## 사용 팁

- **곡 추가**: 상단에 YouTube URL 붙여넣기 → 처리 완료 대기 (Demucs 분리는 곡당 수 분)
- **가사 싱크**: 가사 가져오기 → '가사 생성' → ▶ 재생하며 줄 시작마다 ⏱ 연타 → 저장
- **코드 싱크**: 코드 만들기 → ⏱ 연타로 시간만 찍기 → ↵ 줄바꿈으로 줄 정리 → 코드 입력 → 저장
- **조 변경**: Semitones ± 적용 — 재생 중에 바꿔도 현재 위치에서 이어 재생됨

## 배포 (원클릭 패키지)

```bash
./build_package.sh
```

→ `dist/Practice-Machine-by-SHY-v1.4.0.dmg` 생성 (zip 백업 동봉).

받는 쪽에서는:
1. DMG 열기 → `Practice Machine by SHY` 폴더를 원하는 위치로 이동
2. 폴더 안 `Practice Machine by SHY` 앱 더블클릭 — 첫 실행에 Python 런타임/의존성 자동 설치 후 브라우저 자동 오픈
3. 처음 한 번 "확인되지 않은 개발자" 경고 시: 시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기

앱 3종: `Practice Machine by SHY`(설치+실행) / `종료`(서버 정지) / `제거`(완전 삭제). 프론트 빌드물이 포함되어 받는 맥에 Node 불필요.
