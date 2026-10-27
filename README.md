# Holy Karaoke Stems 🎤 v1.1

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

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLY_PORT` | `8011` | 서버 포트 |
| `HOLY_HOST` | `0.0.0.0` | `localhost`로 바꾸면 이 기기 전용 |
| `HOLY_DATA_DIR` | `backend/data` | 다운로드/스템/DB 저장 위치 |
| `HOLY_DEMUCS_MODEL` | `htdemucs_6s` | Demucs 모델 |
| `HOLY_YTDLP_COOKIES_FROM_BROWSER` | (없음) | chrome/firefox/safari — 연령제한 영상용 |
| `HOLY_FFMPEG` | 자동탐색 | ffmpeg 경로 |
| `HOLY_FOREGROUND` | (없음) | `1` = 포그라운드 실행 (디버깅용) |

## 사용 팁

- **곡 추가**: 상단에 YouTube URL 붙여넣기 → 처리 완료 대기 (Demucs 분리는 곡당 수 분)
- **가사 싱크**: 가사 가져오기 → '가사 생성' → ▶ 재생하며 줄 시작마다 ⏱ 연타 → 저장
- **코드 싱크**: 코드 만들기 → ⏱ 연타로 시간만 찍기 → ↵ 줄바꿈으로 줄 정리 → 코드 입력 → 저장
- **조 변경**: Semitones ± 적용 — 재생 중에 바꿔도 현재 위치에서 이어 재생됨
