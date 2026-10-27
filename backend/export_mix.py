import os
import subprocess
from typing import Dict, List, Tuple

from ffmpeg_locate import ffmpeg_bin


def _ffmpeg() -> str:
    return ffmpeg_bin()


def build_mix_args(stems: Dict[str, str], gains: Dict[str, float]) -> Tuple[List[str], str, str]:
    """Build ffmpeg inputs + filter_complex for mixing stems.

    Returns (input_args, filter_complex, audio_out_label).
    Shared by Export MP3 (file output) and Export Video (mux into video).
    """
    # Keep a stable ordering
    names = sorted(stems.keys())
    inputs: List[str] = []
    for nm in names:
        inputs += ["-i", stems[nm]]

    # Build filter_complex
    # For each input i: [i:a]volume=g[i][ai]
    parts: List[str] = []
    labels: List[str] = []
    for i, nm in enumerate(names):
        g = float(gains.get(nm, 1.0))
        if g < 0:
            g = 0.0
        parts.append(f"[{i}:a]volume={g}[a{i}]")
        labels.append(f"[a{i}]")

    amix = "".join(labels) + f"amix=inputs={len(labels)}:normalize=0[aout]"
    fc = ";".join(parts + [amix])
    return inputs, fc, "[aout]"


def mixdown_to_mp3(stems: Dict[str, str], gains: Dict[str, float], out_mp3: str, *, bitrate: str = "320k") -> str:
    """Mix stems (wav) into a single mp3 using ffmpeg.

    stems: {stem_name: wav_path}
    gains: {stem_name: linear_gain} (missing => 1.0)
    """
    os.makedirs(os.path.dirname(out_mp3), exist_ok=True)

    inputs, fc, aout = build_mix_args(stems, gains)

    cmd = [
        _ffmpeg(),
        "-y",
        *inputs,
        "-filter_complex",
        fc,
        "-map",
        aout,
        "-c:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        out_mp3,
    ]

    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return out_mp3
