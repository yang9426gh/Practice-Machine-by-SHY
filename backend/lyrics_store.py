"""가사 (LRC) — LRCLIB 가져오기 / LRC 붙여넣기 / 편집 저장.

저장 형식: LRC 텍스트 그대로 (data/lyrics/<video_id>.lrc)
+ 메타(offset_sec)는 DB tracks 테이블 컬럼이 아닌 LRC 헤더 태그로 저장:
    [offset:+1200]  (밀리초, + = 가사가 늦게 나옴 → 표시 시간을 앞당김은 음수)
확장 계획(코드/chord)을 위해 lines는 파싱해서 JSON으로도 제공.
"""
from __future__ import annotations

import os
import re
import time
import urllib.parse
import urllib.request
import urllib.error
import json

LRCLIB_BASE = "https://lrclib.net/api"
UA = "HolyKaraokeStems/0.2 (https://github.com/local/holy-karaoke)"

LRC_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
OFFSET_TAG_RE = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)
META_TAG_RE = re.compile(r"^\[(ti|ar|al|length|offset):(.*)\]", re.IGNORECASE)


# -----------------------------
# LRC 파싱/직렬화
# -----------------------------
def parse_lrc(text: str) -> dict:
    """LRC 텍스트 → {meta, lines:[{time,text}]} (시간 오름차순).

    - 여러 타임스탬프가 한 줄에 붙은 경우(복창) 각 시각마다 줄 분리
    - [offset:ms] 태그는 meta로 보관 (표시 단계에서 적용)
    """
    meta: dict[str, str] = {}
    lines: list[dict] = []
    for raw in (text or "").splitlines():
        s = raw.strip()
        if not s:
            continue
        om = OFFSET_TAG_RE.match(s)
        if om:
            meta["offset"] = str(int(om.group(1)))
            continue
        mm = META_TAG_RE.match(s)
        if mm and not LRC_TIME_RE.match(s):
            meta[mm.group(1).lower()] = mm.group(2).strip()
            continue

        stamps = list(LRC_TIME_RE.finditer(s))
        if stamps:
            content = s[stamps[-1].end():].strip()
            for m2 in stamps:
                mm_, ss_, frac_ = m2.group(1), m2.group(2), m2.group(3)
                f = float(f"0.{frac_}") if frac_ else 0.0
                t = int(mm_) * 60 + int(ss_) + f
                if content:
                    lines.append({"time": round(t, 3), "text": content})
        # 타임스탬프 없는 줄은 무시 (일반 텍스트 블록)

    lines.sort(key=lambda x: x["time"])
    return {"meta": meta, "lines": lines}


def serialize_lrc(meta: dict, lines: list[dict]) -> str:
    """{meta, lines} → LRC 텍스트 (편집 저장용)."""
    out: list[str] = []
    ti = meta.get("ti") or meta.get("title")
    ar = meta.get("ar") or meta.get("artist")
    if ti:
        out.append(f"[ti:{ti}]")
    if ar:
        out.append(f"[ar:{ar}]")
    off = meta.get("offset")
    if off not in (None, "", 0, "0"):
        out.append(f"[offset:{int(off)}]")
    for ln in sorted(lines, key=lambda x: float(x.get("time", 0))):
        t = max(0.0, float(ln.get("time", 0)))
        mm = int(t // 60)
        ss = t - mm * 60
        out.append(f"[{mm:02d}:{ss:05.2f}] {str(ln.get('text', '')).strip()}")
    return "\n".join(out) + "\n"


def lrc_to_yaml(lines: list[dict], meta: dict, duration_ms: int | None = None) -> str:
    """LRCLIB lyricsfile 호환 YAML 생성 (향후 chord 확장 대비)."""
    def yq(s: str) -> str:
        return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'

    rows: list[str] = ["version: '1.0'", "metadata:"]
    if meta.get("ti"):
        rows.append(f"  title: {yq(meta['ti'])}")
    if meta.get("ar"):
        rows.append(f"  artist: {yq(meta['ar'])}")
    if duration_ms:
        rows.append(f"  duration_ms: {int(duration_ms)}")
    rows.append("lines:")
    for i, ln in enumerate(lines):
        start = float(ln.get("time", 0)) * 1000
        nxt = float(lines[i + 1]["time"]) * 1000 if i + 1 < len(lines) else None
        end = ln.get("end_ms") or (int(nxt) if nxt else int(start) + 5000)
        rows.append(f"- text: {yq(ln.get('text', ''))}")
        rows.append(f"  start_ms: {int(start)}")
        rows.append(f"  end_ms: {int(end)}")
    return "\n".join(rows) + "\n"


# -----------------------------
# LRCLIB 클라이언트
# -----------------------------
def _lrclib_get(path: str, params: dict, timeout: float = 12.0):
    url = f"{LRCLIB_BASE}{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err: Exception | None = None
    for attempt in range(3):  # 503 busy 재시도
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (502, 503) and attempt < 2:
                last_err = e
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except Exception as e:  # 네트워크 등
            last_err = e
            if attempt < 2:
                time.sleep(1.0)
                continue
            raise
    raise last_err or RuntimeError("lrclib request failed")


def lrclib_get(artist: str, title: str, duration: float | None) -> dict | None:
    """정확 매칭 (duration ±2초). 없으면 None."""
    params = {"artist_name": artist, "track_name": title}
    if duration:
        params["duration"] = str(int(round(duration)))
    try:
        return _lrclib_get("/get", params)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def lrclib_search(artist: str = "", title: str = "", q: str = "") -> list[dict]:
    """후보 검색 — synced 있는 것 우선, duration 가까운 순."""
    if q:
        params = {"q": q}
    else:
        params = {}
        if artist:
            params["artist_name"] = artist
        if title:
            params["track_name"] = title
    res = _lrclib_get("/search", params)
    if not isinstance(res, list):
        return []
    synced = [x for x in res if x.get("syncedLyrics")]
    plain = [x for x in res if not x.get("syncedLyrics")]
    return synced + plain


# -----------------------------
# 저장/로드 (data/lyrics/<video_id>.lrc)
# -----------------------------
def lyrics_dir(data_dir: str) -> str:
    p = os.path.join(data_dir, "lyrics")
    os.makedirs(p, exist_ok=True)
    return p


def lyrics_path(data_dir: str, video_id: str) -> str:
    safe = "".join(c for c in video_id if c.isalnum() or c in "-_")
    return os.path.join(lyrics_dir(data_dir), f"{safe}.lrc")


def load_lrc(data_dir: str, video_id: str) -> str | None:
    p = lyrics_path(data_dir, video_id)
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    return None


def save_lrc(data_dir: str, video_id: str, text: str) -> str:
    p = lyrics_path(data_dir, video_id)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text.replace("\r\n", "\n"))
    return p
