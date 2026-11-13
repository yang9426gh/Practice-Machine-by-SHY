"""Export Video — 영상 + 믹스 오디오 + 코드/가사 자막 번인.

- 오디오: Export MP3와 동일한 믹스(build_mix_args) 사용
- 자막: ASS로 생성해서 libass(subtitles 필터)로 화면 상단 1/3에 번인
  - 코드 줄: 상단, 크고 굵게, \\k 카라오케 하이라이트 (현재 코드 스윕)
  - 가사 줄: 코드 바로 아래
- 코드 표기: 오디오 transpose(semitones) + 표시 전용 키 조절(key_adj) 합성 적용
"""
from __future__ import annotations

import os
import re
import subprocess
from typing import Callable, Dict, List, Optional, Tuple

from export_mix import build_mix_args
from ffmpeg_locate import ffmpeg_bin


def _ffmpeg() -> str:
    return ffmpeg_bin()


# -----------------------------
# 코드 트랜스포즈 (frontend transposeChordText와 동일 로직)
# -----------------------------
CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CHROMATIC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_CHORD_RE = re.compile(r"^([A-G])([#b♯♭]?)(.*)$", re.S)


def transpose_chord_text(text: str, delta: int) -> str:
    """코드 루트만 세미톤 이동. 품질 표기(m7/dim 등) 유지, 슬래시 코드 베이스음도 이동."""
    if not delta:
        return text
    out: List[str] = []
    for part in str(text).split("/"):
        m = _CHORD_RE.match(part)
        if not m:
            out.append(part)
            continue
        root, acc, rest = m.groups()
        try:
            idx = CHROMATIC_SHARP.index(root.upper())
        except ValueError:
            out.append(part)
            continue
        if acc in ("#", "♯"):
            idx += 1
        elif acc in ("b", "♭"):
            idx -= 1
        if idx < 0:
            out.append(part)
            continue
        shifted = (idx + delta) % 12
        prefer_flat = acc in ("b", "♭")
        name = (CHROMATIC_FLAT if prefer_flat else CHROMATIC_SHARP)[shifted]
        out.append(f"{name}{rest}")
    return "/".join(out)


# -----------------------------
# ASS 자막 생성
# -----------------------------
def _fmt_ass_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_escape(text: str) -> str:
    # {} 는 ASS 오버라이드 블록이라 리터럴로 못 씀 → 괄호로 대체, 줄바꿈 제거
    return (
        str(text)
        .replace("{", "(")
        .replace("}", ")")
        .replace("\r", " ")
        .replace("\n", " ")
        .strip()
    )


def build_ass(
    *,
    width: int,
    height: int,
    chord_lines: List[dict],
    lyric_lines: List[dict],
    chord_shift: int = 0,
    font_name: str = "",
) -> str:
    """chord_lines: [{time, chords:[{time,text}]}] (초, 오프셋 적용됨)
    lyric_lines: [{time, text}] (초, 오프셋 적용됨)
    """
    # Windows 배포판엔 맥 폰트가 없음 — 플랫폼 기본 폰트 (한글 tofu 방지)
    if not font_name:
        font_name = "Malgun Gothic" if os.name == "nt" else "Apple SD Gothic Neo"
    # --- 타임라인 계산: 각 이벤트 start → 같은 트랙 다음 이벤트 start (마지막은 +4s) ---
    def _timeline(lines: List[dict], dur: float = 4.0) -> List[Tuple[float, float, dict]]:
        out: List[Tuple[float, float, dict]] = []
        for i, ln in enumerate(lines):
            start = float(ln["time"])
            if i + 1 < len(lines):
                end = float(lines[i + 1]["time"])
            else:
                end = start + dur
            if end - start < 0.2:
                end = start + 0.2
            out.append((start, end, ln))
        return out

    chord_tl = _timeline(chord_lines)
    lyric_tl = _timeline(lyric_lines)

    # --- 스타일 (PlayRes = 실제 영상 해상도) ---
    chord_fs = max(24, round(height * 0.052)) + 3
    lyric_fs = max(16, round(height * 0.040)) + 3
    outline = max(3, round(height * 0.0055))  # 검은 외곽선 — 영상 위에서 자막 구분용
    # 다음 라인 미리보기 (앱 fullscreen 모드처럼 현재+다음 동시 표시)
    chord_next_fs = max(14, round(chord_fs * 0.55)) + 3
    lyric_next_fs = max(12, round(lyric_fs * 0.70)) + 3
    mv_chord = round(height * 0.05)  # 상단 ~5%
    mv_chord_next = round(height * 0.115)  # 현재 코드 아래 (fs 간격)
    mv_lyric = round(height * (0.175 if chord_lines else 0.10))  # 코드 블록 아래, 상단 1/3 안
    mv_lyric_next = round(height * (0.245 if chord_lines else 0.165))  # 현재 가사 아래

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chord,{font_name},{chord_fs},&H00FFFFFF,&H006E6E6E,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,{outline},0,8,60,60,{mv_chord},1
Style: Lyric,{font_name},{lyric_fs},&H00F2F2F2,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline},0,8,60,60,{mv_lyric},1
Style: ChordNext,{font_name},{chord_next_fs},&H00969696,&H006E6E6E,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline},0,8,60,60,{mv_chord_next},1
Style: LyricNext,{font_name},{lyric_next_fs},&H00AAAAAA,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline},0,8,60,60,{mv_lyric_next},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events: List[str] = []

    # --- 코드 줄: \k 카라오케 (다음 코드까지의 시간만큼 스윕) ---
    for i, (start, end, ln) in enumerate(chord_tl):
        evs = ln.get("chords") or []
        if not evs:
            continue
        seg: List[str] = []
        for j, ev in enumerate(evs):
            if j + 1 < len(evs):
                dur_cs = int(round((float(evs[j + 1]["time"]) - float(ev["time"])) * 100))
            else:
                dur_cs = int(round((end - float(ev["time"])) * 100))
            dur_cs = max(1, min(dur_cs, 60000))
            txt = _ass_escape(transpose_chord_text(ev.get("text", ""), chord_shift))
            if not txt:
                txt = "·"
            seg.append(f"{{\\k{dur_cs}}}{txt} ")
        text = "".join(seg).rstrip()
        events.append(f"Dialogue: 0,{_fmt_ass_time(start)},{_fmt_ass_time(end)},Chord,,0,0,0,,{text}")

        # 다음 코드 라인 미리보기 (회색 작은 글씨, 현재 줄 아래)
        if i + 1 < len(chord_tl):
            nxt = chord_tl[i + 1][2]
            nxt_evs = nxt.get("chords") or []
            if nxt_evs:
                nxt_text = " ".join(
                    _ass_escape(transpose_chord_text(ev.get("text", ""), chord_shift)) or "·"
                    for ev in nxt_evs
                )
                events.append(f"Dialogue: 0,{_fmt_ass_time(start)},{_fmt_ass_time(end)},ChordNext,,0,0,0,,{nxt_text}")

    # --- 가사 줄 ---
    for i, (start, end, ln) in enumerate(lyric_tl):
        txt = _ass_escape(ln.get("text", ""))
        if not txt:
            continue
        events.append(f"Dialogue: 1,{_fmt_ass_time(start)},{_fmt_ass_time(end)},Lyric,,0,0,0,,{txt}")

        # 다음 가사 라인 미리보기 (회색 작은 글씨, 현재 줄 아래)
        if i + 1 < len(lyric_tl):
            nxt_txt = _ass_escape(lyric_tl[i + 1][2].get("text", ""))
            if nxt_txt:
                events.append(f"Dialogue: 1,{_fmt_ass_time(start)},{_fmt_ass_time(end)},LyricNext,,0,0,0,,{nxt_txt}")

    return header + "\n".join(events) + "\n"


# -----------------------------
# 영상 프로브 (해상도/길이) — imageio-ffmpeg엔 ffprobe가 없어서 ffmpeg -i 파싱
# -----------------------------
def probe_video(path: str) -> Tuple[int, int, float]:
    ff = _ffmpeg()
    p = subprocess.run(
        [ff, "-hide_banner", "-i", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )
    out = p.stdout or ""
    w = h = 0
    dur = 0.0
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    if not (w and h):
        raise RuntimeError("could not probe video resolution")
    return w, h, dur


# -----------------------------
# Export 실행
# -----------------------------
_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


class VideoExportCancelled(Exception):
    """사용자가 Export Video를 취소함."""


def export_video(
    *,
    video_path: str,
    stems: Dict[str, str],
    gains: Dict[str, float],
    ass_path: str = "",
    out_path: str,
    duration_hint: float = 0.0,
    progress_cb: Optional[Callable[[int], None]] = None,
    cancel_event=None,
    proc_holder: Optional[dict] = None,
) -> str:
    """영상 + (스템 믹스 오디오) + ASS 자막 번인(선택) → mp4. libass 한글은 macOS 시스템 폰트 사용.
    ass_path가 빈 문자열이면 자막 없이 인코딩 (가사/코드 없는 곡 지원)."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    ff = _ffmpeg()
    # 영상이 input 0이므로 스템 입력은 1부터 — [0:a](영상 원본 오디오)가 믹스에 섞이지 않게 함
    mix_inputs, mix_fc, aout = build_mix_args(stems, gains, input_offset=1)

    # 자막이 있을 때만 subtitles 필터 적용 (없으면 영상 그대로)
    if ass_path and os.path.exists(ass_path):
        ass_arg = ass_path.replace("\\", "/").replace(":", "\\:")
        if os.name == "nt":
            fonts_dirs = "C\\:/Windows/Fonts"
        else:
            fonts_dirs = "/System/Library/Fonts:/System/Library/Fonts/Supplemental".replace(":", "\\:")
        vf = f"subtitles=filename='{ass_arg}':fontsdir='{fonts_dirs}'"
        fc = f"[0:v]{vf}[vout];" + mix_fc
    else:
        fc = f"[0:v]null[vout];" + mix_fc

    cmd = [
        ff,
        "-y",
        "-hide_banner",
        "-i", video_path,
        *mix_inputs,
        "-filter_complex", fc,
        "-map", "[vout]",
        "-map", aout,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "256k",
        "-shortest",
        "-movflags", "+faststart",
        out_path,
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
    )
    if proc_holder is not None:
        proc_holder["proc"] = proc

    def _stop_if_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
            raise VideoExportCancelled()

    total = float(duration_hint or 0.0)
    assert proc.stdout is not None
    for line in proc.stdout:
        _stop_if_cancelled()
        if progress_cb and total > 0:
            m = _TIME_RE.search(line)
            if m:
                t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                progress_cb(max(0, min(99, int(t / total * 100))))

    rc = proc.wait()
    _stop_if_cancelled()
    if rc != 0:
        raise RuntimeError(f"ffmpeg export video failed (exit {rc})")
    return out_path
