"""코드악보 (Chords) — 직접 입력/편집 전용 (외부 DB 없음).

포맷: LRC와 동일한 타임스탬프, 한 줄에 코드 여러 개 나열 가능.
  [00:07.82] Am[00:08.44] Bm[00:09.82] C7
같은 줄의 코드들은 표시 단계에서 한 줄로 그룹핑되고, 시간에 맞춰 개별 코드 하이라이트.
줄바꿈 = 표시 줄 구분. [offset:ms] 태그 지원 (가사와 동일).
저장: 라이브러리 DB(presets.chords_lrc)에 원문 그대로.
"""
from __future__ import annotations

import re

from lyrics_store import LRC_TIME_RE, OFFSET_TAG_RE, META_TAG_RE


def _stamp_time(m: re.Match) -> float:
    mm_, ss_, frac_ = m.group(1), m.group(2), m.group(3)
    f = float(f"0.{frac_}") if frac_ else 0.0
    return int(mm_) * 60 + int(ss_) + f


def parse_chords(text: str) -> dict:
    """코드 LRC 텍스트 → {meta, lines:[{time, chords:[{time,text}]}]}.

    - 한 줄에 타임스탬프가 여러 개면: 각 스탬프 뒤 토큰이 코드 이벤트,
      줄은 첫 스탬프 시각 기준으로 그룹핑
    - 토큰이 빈 스탬프(시간만 찍힘)는 표시에서 무시 — 편집 중 임시 스탬프
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
        if not stamps:
            continue
        chords: list[dict] = []
        for i, m in enumerate(stamps):
            seg_end = stamps[i + 1].start() if i + 1 < len(stamps) else len(s)
            token = s[m.end():seg_end].strip()
            token = " ".join(token.split())  # 내부 공백 정귬화 (표시용)
            if token:
                chords.append({"time": round(_stamp_time(m), 3), "text": token})
        if chords:
            lines.append({"time": chords[0]["time"], "chords": chords})

    lines.sort(key=lambda x: float(x["time"]))
    return {"meta": meta, "lines": lines}


def serialize_chords(meta: dict, lines: list[dict]) -> str:
    """{meta, lines} → 코드 LRC 텍스트 (편집 저장용)."""
    out: list[str] = []
    off = meta.get("offset")
    if off not in (None, "", 0, "0"):
        out.append(f"[offset:{int(off)}]")
    for ln in sorted(lines, key=lambda x: float(x.get("time", 0))):
        parts: list[str] = []
        for c in ln.get("chords", []):
            t = max(0.0, float(c.get("time", 0)))
            mm = int(t // 60)
            ss = t - mm * 60
            tok = str(c.get("text", "")).strip()
            if tok:
                parts.append(f"[{mm:02d}:{ss:05.2f}] {tok}")
        if parts:
            out.append("".join(parts))
    return "\n".join(out) + "\n"


# -----------------------------
# 저장/조회 (DB)
# -----------------------------
def load_chords(data_dir: str, video_id: str) -> str | None:
    from db import get_preset_chords
    return get_preset_chords(data_dir, video_id)


def save_chords(data_dir: str, video_id: str, text: str) -> None:
    from db import set_preset_chords
    set_preset_chords(data_dir, video_id, text.replace("\r\n", "\n"))
