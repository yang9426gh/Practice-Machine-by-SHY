# Holy Karaoke Stems 🎤

YouTube 노래를 AI로 스템 분리(보컬/반주/드럼/베이스...)해서 노래방처럼 부르는 앱.

## 구성

- **backend/** — FastAPI (yt-dlp 다운로드 → Demucs 6스템 분리(MPS 가속) → 키/조 변경 → MP3 익스포트 → SQLite 라이브러리·프리셋)
- **frontend/** — Next.js (정적 익스포트, FastAPI가 직접 서빙)

## 설치 & 실행

```bash
./install.sh   # 최초 1회: venv + 의존성 + 프론트 빌드
./run.sh       # 백엔드+프론트 단일 프로세스 실행 → http://localhost:8011
```

필요: macOS(Apple Silicon 권장), Python 3.10+, Node 18+ (빌드시에만)

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLY_DATA_DIR` | `backend/data` | 다운로드/스템/DB 저장 위치 |
| `HOLY_DEMUCS_MODEL` | `htdemucs_6s` | Demucs 모델 |
| `HOLY_YTDLP_COOKIES_FROM_BROWSER` | (없음) | chrome/firefox/safari — 연령제한 영상용 |
| `HOLY_FFMPEG` | 자동탐색 | ffmpeg 경로 |
