"""faster-whisper 래퍼 — openai-whisper/whisperx API 호환 레이어.

- get_whisper_model(name): 캐시된 WhisperModel 반환 (기존 main.py 호환)
- transcribe_with_words(): segments + word timestamps 반환 (기존 result 형태 호환)
- 언어: HOLY_WHISPER_LANG 환경변수 (auto/ko/en/...) — 기본 auto
"""
from __future__ import annotations

import os
import threading
from typing import Any

_MODELS: dict[str, Any] = {}
_LOCK = threading.Lock()


def whisper_lang() -> str | None:
    """설정된 언어 코드. 'auto' 또는 미설정이면 None (자동감지)."""
    lang = (os.environ.get("HOLY_WHISPER_LANG") or "auto").strip().lower()
    return None if lang in ("", "auto", "auto-detect") else lang


def get_whisper_model(name: str):
    """WhisperModel 캐시 로더 (스레드세이프)."""
    with _LOCK:
        m = _MODELS.get(name)
        if m is None:
            from faster_whisper import WhisperModel

            # Apple Silicon: CPU int8이 MPS보다 실측 빠름 (faster-whisper는 MPS 미지원)
            m = WhisperModel(name, device="cpu", compute_type="int8")
            _MODELS[name] = m
        return m


def transcribe_with_words(
    audio_path: str,
    model_name: str = "base",
    *,
    language: str | None = None,
    initial_prompt: str | None = None,
) -> dict[str, list]:
    """openai-whisper의 result {segments:[{start,end,text,words:[...]}]} 형태로 반환."""
    model = get_whisper_model(model_name)
    lang = language if language is not None else whisper_lang()

    segments_iter, info = model.transcribe(
        audio_path,
        language=lang,
        task="transcribe",
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
        word_timestamps=True,
        vad_filter=True,          # 무음구간 스킵 — 노래에 특히 효과적
        vad_parameters={"min_silence_duration_ms": 500},
    )

    segments: list[dict] = []
    for s in segments_iter:
        seg = {
            "start": float(s.start),
            "end": float(s.end),
            "text": (s.text or "").strip(),
            "words": [
                {"start": float(w.start), "end": float(w.end), "word": (w.word or "").strip()}
                for w in (s.words or [])
            ],
        }
        segments.append(seg)

    return {"segments": segments, "language": getattr(info, "language", None)}


def words_from_result(result: dict) -> list[dict]:
    """result에서 word 리스트 추출 (기존 main.py 패턴 호환)."""
    words: list[dict] = []
    for seg in result.get("segments") or []:
        for w in seg.get("words") or []:
            words.append({"start": w.get("start"), "end": w.get("end"), "word": w.get("word")})
    return words


def words_ok(words: list[dict]) -> bool:
    """단어 타임스탬프 degeneracy 검사 — 반복 필러("oh","uh")로 붕괴했으면 False."""
    if not words:
        return False
    if len(words) < 30:
        return True
    toks = [(w.get("word") or "").strip().lower() for w in words]
    toks = [t for t in toks if t and any(ch.isalpha() for ch in t)]
    if not toks:
        return False
    from collections import Counter
    c = Counter(toks)
    _, top_cnt = c.most_common(1)[0]
    top_ratio = top_cnt / max(1, len(toks))
    return not (top_ratio > 0.20 or len(c) < 25)
