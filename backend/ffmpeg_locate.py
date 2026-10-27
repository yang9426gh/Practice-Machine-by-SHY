"""ffmpeg 바이너리 탐색 — Homebrew 의존 제거.

우선순위:
1. HOLY_FFMPEG 환경변수
2. imageio-ffmpeg 번들 바이너리 (pip 설치 — 별도 설치 불필요)
3. PATH 상의 ffmpeg (homebrew 등)
"""
from __future__ import annotations

import os
import shutil


def ffmpeg_bin() -> str:
    env = os.environ.get("HOLY_FFMPEG", "").strip()
    if env and os.path.isfile(env):
        return env

    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass

    found = shutil.which("ffmpeg")
    if found:
        return found

    # 일반적인 homebrew 경로 최후 폴백
    for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if os.path.isfile(p):
            return p

    raise FileNotFoundError(
        "ffmpeg not found. Install with: pip install imageio-ffmpeg (recommended) "
        "or brew install ffmpeg, or set HOLY_FFMPEG=/path/to/ffmpeg"
    )
