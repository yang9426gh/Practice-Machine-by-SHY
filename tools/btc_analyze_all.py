#!/usr/bin/env python3
"""Analyze ALL presets that have demucs stems but no chords_btc.json yet (skip if exists).
Usage: btc_analyze_all.py [--force]

BTC (ISMIR 2019 양방향 트랜스포머) 전곡 코드 타이밍 사이드카 생성.
- 실행: ~/projects/btc_chord_env/bin/python tools/btc_analyze_all.py
- 요구: 곡별 htdemucs_6s/original/{bass,other,guitar,piano}.flac 스템
- 산출: backend/data/<tid>/chords_btc.json (✦ 스탬프 채우기가 조회하는 파일)
- 새 곡 추가 후 이 스크립트를 다시 돌리면 없는 곡만 분석한다.
"""
import hashlib
import json
import os
import sqlite3
import sys

import librosa
import numpy as np
import soundfile as sf

BACKEND = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"
)
FORCE = "--force" in sys.argv


def main():
    from transformers import AutoModel
    con = sqlite3.connect(os.path.join(BACKEND, "data", "index.db"))
    rows = con.execute("SELECT video_id, title FROM presets").fetchall()
    con.close()
    todo = []
    for vid, title in rows:
        tid = hashlib.sha1(vid.encode()).hexdigest()[:16]
        d = os.path.join(BACKEND, "data", tid, "htdemucs_6s", "original")
        side = os.path.join(BACKEND, "data", tid, "chords_btc.json")
        if os.path.exists(side) and not FORCE:
            print(f"skip (exists): {vid}", flush=True)
            continue
        if not os.path.isdir(d):
            print(f"skip (no stems): {vid}", flush=True)
            continue
        todo.append((vid, title, d, side))
    print(f"to analyze: {len(todo)}", flush=True)
    if not todo:
        return
    model = AutoModel.from_pretrained("puar-playground/btc-chord", trust_remote_code=True, large_voca=True)
    for vid, title, d, side in todo:
        try:
            mix, sr = None, None
            for role in ("bass", "other", "guitar", "piano"):
                x, sr = sf.read(os.path.join(d, role + ".flac"), dtype="float32", always_2d=True)
                m = x.mean(axis=1)
                mix = m if mix is None else mix + m
            a22 = librosa.resample(mix.astype(np.float32), orig_sr=sr, target_sr=22050).astype(np.float32)
            tl = model.predict(a22)
            out = {"model": "puar-playground/btc-chord", "large_voca": True, "sr": 22050,
                   "input": "bass+other+guitar+piano", "title": title, "segments": tl}
            with open(side, "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False)
            print(f"ok: {vid} ({title}) -> {len(tl)} segments", flush=True)
        except Exception as e:
            print(f"FAIL: {vid}: {e}", flush=True)


if __name__ == "__main__":
    main()
