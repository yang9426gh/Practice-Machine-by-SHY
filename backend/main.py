from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import HTTPException
from fastapi import Body
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
import os
import shutil
import hashlib
import threading
import traceback
from processor import download_youtube_audio, download_youtube_video, separate_stems
from ytmusicapi import YTMusic

from db import init_db, upsert_track, get_track, list_tracks, upsert_preset, list_presets, delete_preset, delete_track

YTM = YTMusic()

from ffmpeg_locate import ffmpeg_bin


def wav_duration_seconds(path: str) -> float:
    """Cheap duration reader for WAV files (no ffmpeg dependency)."""
    try:
        import wave
        with wave.open(path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate() or 1
            return float(frames) / float(rate)
    except Exception:
        return 0.0


app = FastAPI()


# -----------------------------
# Queue / background worker
# -----------------------------
# NOTE: these must be defined BEFORE starting the worker thread.
from collections import deque

QUEUE = deque()  # items: (url, output_dir, task_id)
QUEUE_LOCK = threading.Lock()
QUEUE_COND = threading.Condition(QUEUE_LOCK)
CURRENT: dict | None = None  # {task_id, url}


def _queue_worker():
    global CURRENT
    while True:
        with QUEUE_COND:
            while not QUEUE:
                QUEUE_COND.wait()
            url, output_dir, task_id = QUEUE.popleft()
            CURRENT = {"task_id": task_id, "url": url}

        try:
            run_pipeline(url, output_dir, task_id)
        except Exception:
            # run_pipeline already sets error stage
            pass
        finally:
            with QUEUE_COND:
                if CURRENT and CURRENT.get("task_id") == task_id:
                    CURRENT = None


WORKER_THREAD = threading.Thread(target=_queue_worker, daemon=True)
WORKER_THREAD.start()

# 프론트엔드와 통신을 위한 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Data/cache directory (can override with HOLY_DATA_DIR)
DATA_DIR = os.environ.get("HOLY_DATA_DIR") or os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

# in-memory task progress (simple dev implementation)
TASKS: dict[str, dict] = {}
TASKS_LOCK = threading.Lock()

# cancellation + running processes (best-effort)
CANCELLED: set[str] = set()
RUNNING_PROCS: dict[str, object] = {}
RUNNING_LOCK = threading.Lock()

# job history
from collections import deque as _deque
JOB_HISTORY = _deque(maxlen=50)  # each: {task_id,url,status,stage,progress,ts}

# init cache DB
init_db(DATA_DIR)

# 분리된 파일들을 웹에서 접근 가능하게 설정
app.mount("/audio", StaticFiles(directory=DATA_DIR), name="audio")


class PresetIn(BaseModel):
    id: str
    name: str
    source_url: str
    video_id: str
    title: str | None = None
    thumbnail_url: str | None = None
    bpm: float | None = None
    key_tonic: str | None = None  # e.g. C, C#, D...
    key_mode: str | None = None   # major|minor
    semitones: int = 0
    master_volume: float = 1.0
    vocal_volume: float = 1.0

def video_id_from_url(url: str) -> str:
    # supports youtube.com/watch?v=... and youtu.be/... and music.youtube.com
    try:
        from urllib.parse import urlparse, parse_qs

        u = urlparse(url)
        if u.netloc.endswith("youtu.be"):
            vid = u.path.strip("/")
            return vid
        qs = parse_qs(u.query)
        vid = (qs.get("v") or [""])[0]
        return vid
    except Exception:
        # fallback best-effort
        if "v=" in url:
            return url.split("v=")[1].split("&")[0]
        return url.split("/")[-1].split("?")[0]


def canonical_watch_url(url: str) -> str:
    vid = video_id_from_url(url)
    if not vid:
        return url
    return f"https://www.youtube.com/watch?v={vid}"


def task_id_for_url(url: str) -> str:
    # deterministic by video id (avoid list/start_radio params breaking cache)
    vid = video_id_from_url(url) or url.strip()
    return hashlib.sha1(vid.encode("utf-8")).hexdigest()[:16]


def output_paths(task_id: str):
    out_dir = os.path.join(DATA_DIR, task_id)
    # legacy paths (2-stem). 6-stem will be discovered dynamically via find_stems().
    # flac 우선, 레거시 wav 폴백 (6-stem)
    orig_dir = os.path.join(out_dir, "htdemucs", "original")
    vocals = os.path.join(orig_dir, "vocals.flac")
    if not os.path.exists(vocals):
        vocals = os.path.join(orig_dir, "vocals.wav")
    no_vocals = os.path.join(orig_dir, "no_vocals.flac")
    if not os.path.exists(no_vocals):
        no_vocals = os.path.join(orig_dir, "no_vocals.wav")
    video = os.path.join(out_dir, "video.mp4")
    return out_dir, vocals, no_vocals, video


def find_stems(out_dir: str) -> dict[str, str]:
    """Return {stem: audio_path} from demucs output. Prefers .flac, falls back to .wav (legacy)."""
    candidates = []
    m = os.environ.get("HOLY_DEMUCS_MODEL", "htdemucs_6s")
    candidates.append(os.path.join(out_dir, m, "original"))
    candidates.append(os.path.join(out_dir, "htdemucs", "original"))
    candidates.append(os.path.join(out_dir, "htdemucs_6s", "original"))
    for c in candidates:
        if os.path.isdir(c):
            stems = {}
            for fn in os.listdir(c):
                low = fn.lower()
                if low.endswith(".flac"):
                    stems[os.path.splitext(fn)[0]] = os.path.join(c, fn)
                elif low.endswith(".wav"):
                    # .wav는 동명 .flac이 없을 때만 (레거시 폴백)
                    if os.path.splitext(fn)[0] not in stems:
                        stems[os.path.splitext(fn)[0]] = os.path.join(c, fn)
            if stems:
                return stems
    return {}


@app.post("/process")
async def process_video(url: str, background_tasks: BackgroundTasks, use_test_run: bool = False, queued: bool = False):
    task_id = task_id_for_url(url)
    output_dir, vocals_file, no_vocals_file, video_file = output_paths(task_id)
    os.makedirs(output_dir, exist_ok=True)

    # If we already cached this video_id, return immediately.
    vid = video_id_from_url(url)
    if vid:
        cached = get_track(DATA_DIR, vid)
        if cached and os.path.exists(cached.get("vocals_path", "")) and os.path.exists(cached.get("no_vocals_path", "")):
            tid = cached.get("task_id")
            video_path = os.path.join(DATA_DIR, str(tid), "video.mp4") if tid else ""
            return {"task_id": tid, "status": "completed", "cached": True, "video": f"/audio/{tid}/video.mp4" if tid and os.path.exists(video_path) else None}

    # cache hit -> already completed (multi-stem)
    if find_stems(output_dir):
        return {"task_id": task_id, "status": "completed", "video": f"/audio/{task_id}/video.mp4" if os.path.exists(video_file) else None}

    # legacy cache hit (2-stem)
    if os.path.exists(vocals_file) and os.path.exists(no_vocals_file):
        return {"task_id": task_id, "status": "completed", "video": f"/audio/{task_id}/video.mp4" if os.path.exists(video_file) else None}

    # optional dev shortcut: reuse local test_run outputs
    if use_test_run:
        test_run_dir = os.path.join(DATA_DIR, "test_run")
        test_vocals = os.path.join(test_run_dir, "htdemucs", "original", "vocals.wav")
        test_no_vocals = os.path.join(test_run_dir, "htdemucs", "original", "no_vocals.wav")
        if os.path.exists(test_vocals) and os.path.exists(test_no_vocals):
            try:
                link_path = os.path.join(output_dir, "htdemucs")
                if not os.path.exists(link_path):
                    os.symlink(os.path.join(test_run_dir, "htdemucs"), link_path)
                return {"task_id": task_id, "status": "completed"}
            except Exception:
                pass

    # run in background (can take minutes)
    set_task(task_id, status="processing", stage="queued", progress=0)

    if queued:
        with QUEUE_COND:
            QUEUE.append((url, output_dir, task_id))
            QUEUE_COND.notify()
        return {"task_id": task_id, "status": "processing", "queued": True}

    background_tasks.add_task(run_pipeline, url, output_dir, task_id)
    return {"task_id": task_id, "status": "processing", "queued": False}


def set_task(task_id: str, **patch):
    with TASKS_LOCK:
        cur = TASKS.get(task_id, {})
        cur.update(patch)
        TASKS[task_id] = cur


def is_cancelled(task_id: str) -> bool:
    return task_id in CANCELLED


def register_proc(task_id: str, proc):
    with RUNNING_LOCK:
        RUNNING_PROCS[task_id] = proc


def clear_proc(task_id: str):
    with RUNNING_LOCK:
        RUNNING_PROCS.pop(task_id, None)


def push_history(task_id: str, url: str, status: str, stage: str | None, progress: int | float | None):
    import time
    JOB_HISTORY.appendleft(
        {
            "task_id": task_id,
            "url": url,
            "status": status,
            "stage": stage,
            "progress": progress,
            "ts": int(time.time()),
        }
    )


def run_pipeline(url: str, output_dir: str, task_id: str):
    try:
        if is_cancelled(task_id):
            raise RuntimeError("cancelled")

        vid = video_id_from_url(url)
        set_task(task_id, status="processing", stage="downloading", progress=0, url=url)

        canon = canonical_watch_url(url)

        # Download video for local playback (720p max) - cache reused by task_id
        set_task(task_id, status="processing", stage="downloading_video", progress=0)
        try:
            download_youtube_video(
                canon,
                output_dir,
                max_height=720,
                cancel_cb=lambda: is_cancelled(task_id),
                proc_cb=lambda p: register_proc(task_id, p),
                progress_cb=lambda p: set_task(task_id, progress=p),
            )
        finally:
            clear_proc(task_id)

        if is_cancelled(task_id):
            raise RuntimeError("cancelled")

        set_task(task_id, status="processing", stage="downloading_audio", progress=0)
        orig_file = download_youtube_audio(
            canon,
            output_dir,
            cancel_cb=lambda: is_cancelled(task_id),
            proc_cb=lambda p: register_proc(task_id, p),
            progress_cb=lambda p: set_task(task_id, progress=p),
        )
        clear_proc(task_id)

        if is_cancelled(task_id):
            raise RuntimeError("cancelled")

        set_task(task_id, status="processing", stage="separating", progress=0)
        separate_stems(
            orig_file,
            output_dir,
            task_id=task_id,
            model_name=os.environ.get("HOLY_DEMUCS_MODEL", "htdemucs_6s"),
            progress_cb=lambda p: set_task(task_id, progress=p),
            cancel_cb=lambda: is_cancelled(task_id),
            proc_cb=lambda p: register_proc(task_id, p),
        )
        clear_proc(task_id)

        stems = find_stems(output_dir)
        vocals_path = stems.get("vocals") or ""
        no_vocals_path = stems.get("no_vocals") or stems.get("accompaniment") or ""

        # write to db for fast re-use
        if vid and os.path.exists(vocals_path) and os.path.exists(no_vocals_path):
            title = None
            artist = None
            cover_url = None
            try:
                wp = YTM.get_watch_playlist(vid)
                if wp.get("tracks"):
                    t = wp["tracks"][0]
                    title = t.get("title")
                    if t.get("artists"):
                        artist = t["artists"][0].get("name")
                    thumbs = t.get("thumbnail") or []
                    if thumbs:
                        cover_url = sorted(thumbs, key=lambda x: (x.get("width", 0), x.get("height", 0)))[-1].get("url")
            except Exception:
                pass

            upsert_track(
                DATA_DIR,
                video_id=vid,
                source_url=canon,
                task_id=task_id,
                title=title,
                artist=artist,
                cover_url=cover_url,
                vocals_path=vocals_path,
                no_vocals_path=no_vocals_path,
            )

        set_task(task_id, status="completed", stage="completed", progress=100)
        push_history(task_id, url, "completed", "completed", 100)
    except Exception as e:
        if str(e) == "cancelled" or "cancelled" in str(e).lower():
            set_task(task_id, status="cancelled", stage="cancelled", progress=0, error="cancelled")
            push_history(task_id, url, "cancelled", "cancelled", 0)
            return
        set_task(task_id, status="error", stage="error", error=str(e) + "\n" + traceback.format_exc())
        push_history(task_id, url, "error", "error", 0)
        raise


@app.get("/status/{task_id}")
async def get_status(task_id: str):
    output_dir, vocals_file, no_vocals_file, video_file = output_paths(task_id)

    # fallback: if someone already created a test_run, allow task_id=test_run
    if task_id == "test_run":
        output_dir = os.path.join(DATA_DIR, "test_run")
        vocals_file = os.path.join(output_dir, "htdemucs", "original", "vocals.wav")
        no_vocals_file = os.path.join(output_dir, "htdemucs", "original", "no_vocals.wav")
        video_file = os.path.join(output_dir, "video.mp4")

    stems = find_stems(output_dir)

    with TASKS_LOCK:
        meta = TASKS.get(task_id, {}).copy()

    # prefer multi-stem completion if available
    if stems:
        stage = meta.get("stage")

        # If error happened during post-processing/resync, surface it even though audio exists
        if stage == "error":
            rel = os.path.relpath(os.path.join(output_dir, os.environ.get("HOLY_DEMUCS_MODEL", "htdemucs_6s"), "original"), DATA_DIR)
            if not os.path.isdir(os.path.join(DATA_DIR, rel)):
                # fallback to whatever folder we discovered
                # stems paths are absolute; make relative to DATA_DIR for StaticFiles
                rel = os.path.relpath(os.path.dirname(next(iter(stems.values()))), DATA_DIR)

            return {
                "status": "error",
                "stage": "error",
                "progress": meta.get("progress", 0),
                "error": meta.get("error"),
                "stems": {k: f"/audio/{os.path.relpath(v, DATA_DIR)}" for k, v in stems.items()},
                "video": f"/audio/{os.path.basename(output_dir)}/video.mp4" if os.path.exists(video_file) else None,
            }

        # If we have audio but post-processing is still running, keep status=processing.
        if stage and stage != "completed":
            return {
                "status": "processing",
                "stage": stage,
                "progress": meta.get("progress", 0),
                "stems": {k: f"/audio/{os.path.relpath(v, DATA_DIR)}" for k, v in stems.items()},
            }

        return {
            "status": "completed",
            "stage": meta.get("stage", "completed"),
            "progress": meta.get("progress", 100),
            "stems": {k: f"/audio/{os.path.relpath(v, DATA_DIR)}" for k, v in stems.items()},
            "video": f"/audio/{os.path.basename(output_dir)}/video.mp4" if os.path.exists(video_file) else None,
        }

    if meta.get("stage") == "error":
        return {"status": "error", **meta}

    return {
        "status": "processing",
        "stage": meta.get("stage", "processing"),
        "progress": meta.get("progress", 0),
    }

@app.get("/meta/{video_id}")
async def meta(video_id: str):
    """Basic metadata (title/artist/album cover) from YouTube Music."""
    try:
        wp = YTM.get_watch_playlist(video_id)
        if not wp.get("tracks"):
            raise HTTPException(status_code=404, detail="No track metadata")
        t = wp["tracks"][0]
        thumbs = t.get("thumbnail") or []
        cover = None
        if thumbs:
            # pick largest
            cover = sorted(thumbs, key=lambda x: (x.get("width", 0), x.get("height", 0)))[-1].get("url")
        artist = None
        if t.get("artists"):
            artist = t["artists"][0].get("name")
        return {
            "video_id": video_id,
            "title": t.get("title"),
            "artist": artist,
            "cover_url": cover,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"No metadata available: {e}")


@app.get("/queue")
async def queue_status():
    with QUEUE_LOCK:
        items = [{"task_id": t[2], "url": t[0]} for t in list(QUEUE)]
        current = CURRENT
    return {"current": current, "items": items}


@app.get("/jobs")
async def jobs():
    """Unified jobs view: current + queue + recent."""
    with QUEUE_LOCK:
        q_items = [{"task_id": t[2], "url": t[0]} for t in list(QUEUE)]
        cur = CURRENT

    # attach task meta if present
    def meta_for(tid: str):
        with TASKS_LOCK:
            return TASKS.get(tid, {}).copy()

    current = None
    if cur and cur.get("task_id"):
        tid = cur.get("task_id")
        m = meta_for(tid)
        current = {**cur, **m}

    queue = []
    for it in q_items:
        tid = it["task_id"]
        m = meta_for(tid)
        queue.append({**it, **m})

    recent = list(JOB_HISTORY)
    return {"current": current, "queue": queue, "recent": recent}


@app.post("/jobs/{task_id}/cancel")
async def cancel_job(task_id: str):
    """Best-effort cancel: remove from queue and/or terminate running proc."""
    CANCELLED.add(task_id)

    removed = False
    with QUEUE_COND:
        kept = deque([x for x in QUEUE if x[2] != task_id])
        removed = len(kept) != len(QUEUE)
        QUEUE.clear()
        QUEUE.extend(kept)

    # terminate process if running
    with RUNNING_LOCK:
        proc = RUNNING_PROCS.get(task_id)
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass

    set_task(task_id, status="cancelled", stage="cancelled", progress=0, error="cancelled")
    return {"ok": True, "removed_from_queue": removed}


@app.get("/tracks")
async def library(limit: int = 50):
    """List cached tracks (for UI). /library는 SPA 라이브러리 페이지에 양보."""
    items = list_tracks(DATA_DIR, limit=limit)
    # keep response small
    out = []
    for it in items:
        out.append({
            "video_id": it.get("video_id"),
            "source_url": it.get("source_url"),
            "task_id": it.get("task_id"),
            "title": it.get("title"),
            "artist": it.get("artist"),
            "cover_url": it.get("cover_url"),
            "updated_at": it.get("updated_at"),
        })
    return {"items": out}


# -----------------------------
# Presets (library for UI)
# -----------------------------

@app.get("/presets")
async def presets(limit: int = 100, sort: str = "recent"):
    items = list_presets(DATA_DIR, limit=limit)

    # Sort options: recent (default), bpm_asc, bpm_desc, key_asc, key_desc
    if sort == "bpm_asc":
        items = sorted(items, key=lambda x: (x.get("bpm") is None, float(x.get("bpm") or 0)))
    elif sort == "bpm_desc":
        items = sorted(items, key=lambda x: (x.get("bpm") is None, -float(x.get("bpm") or 0)))
    elif sort in ("key_asc", "key_desc"):
        order = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}

        def key_tuple(x):
            tonic = x.get("key_tonic")
            mode = x.get("key_mode")
            # mode order: major first, then minor
            mo = 0 if str(mode) == "major" else 1 if str(mode) == "minor" else 2
            to = order.get(str(tonic), 99)
            missing = tonic is None or mode is None
            return (missing, to, mo)

        items = sorted(items, key=key_tuple, reverse=(sort == "key_desc"))
    # else: keep DB order (updated_at desc)

    out = []

    async def fetch_oembed(vid: str):
        try:
            import aiohttp

            canonical = f"https://www.youtube.com/watch?v={vid}"
            url = f"https://www.youtube.com/oembed?url={canonical}&format=json"
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status != 200:
                        return None
                    return await resp.json()
        except Exception:
            return None

    # quick lookup of queue/current status by task_id
    with QUEUE_LOCK:
        q_tids = {t[2] for t in list(QUEUE)}
        cur_tid = (CURRENT or {}).get("task_id") if CURRENT else None

    for it in items:
        vid = it.get("video_id")

        # Fill missing title/thumbnail via YouTube oEmbed (best-effort), and persist to DB.
        if vid and (not it.get("title") or not it.get("thumbnail_url")):
            oe = await fetch_oembed(str(vid))
            if oe:
                new_title = (oe.get("title") or "").strip() or None
                new_thumb = (oe.get("thumbnail_url") or "").strip() or None
                if new_title and not it.get("title"):
                    it["title"] = new_title
                if new_thumb and not it.get("thumbnail_url"):
                    it["thumbnail_url"] = new_thumb

                try:
                    upsert_preset(
                        DATA_DIR,
                        id=it.get("id"),
                        name=it.get("name") or (it.get("title") or str(vid)),
                        source_url=it.get("source_url") or canonical_watch_url(str(vid)),
                        video_id=str(vid),
                        title=it.get("title"),
                        thumbnail_url=it.get("thumbnail_url"),
                        bpm=it.get("bpm"),
                        semitones=int(it.get("semitones") or 0),
                        master_volume=float(it.get("master_volume") or 1.0),
                        vocal_volume=float(it.get("vocal_volume") or 1.0),
                    )
                except Exception:
                    pass

        tid = hashlib.sha1(str(vid).encode("utf-8")).hexdigest()[:16] if vid else None
        video_path = os.path.join(DATA_DIR, str(tid), "video.mp4") if tid else ""

        meta = {}
        if tid:
            with TASKS_LOCK:
                meta = TASKS.get(tid, {}).copy()

        stage = meta.get("stage")
        progress = meta.get("progress")
        status = meta.get("status")

        out.append(
            {
                **it,
                "task_id": tid,
                "video_ready": bool(tid and os.path.exists(video_path)),
                "job": {
                    "status": status,
                    "stage": stage,
                    "progress": progress,
                    "is_current": bool(tid and cur_tid and tid == cur_tid),
                    "is_queued": bool(tid and tid in q_tids),
                },
            }
        )

    return {"items": out}


@app.get("/presets/{preset_id}")
async def presets_get_one(preset_id: str):
    try:
        from preset_endpoints import get_preset_or_404

        return {"ok": True, "item": get_preset_or_404(DATA_DIR, preset_id)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"preset lookup failed: {e}")


@app.post("/presets")
async def presets_upsert(p: PresetIn):
    upsert_preset(
        DATA_DIR,
        id=p.id,
        name=p.name,
        source_url=p.source_url,
        video_id=p.video_id,
        title=p.title,
        thumbnail_url=p.thumbnail_url,
        bpm=p.bpm,
        key_tonic=p.key_tonic,
        key_mode=p.key_mode,
        semitones=p.semitones,
        master_volume=p.master_volume,
        vocal_volume=p.vocal_volume,
    )
    return {"ok": True}


@app.post("/presets/{preset_id}/meta")
async def presets_meta(
    preset_id: str,
    payload: dict = Body(default={}),  # noqa: B008
):
    """Patch preset metadata without overwriting the user-defined name."""
    try:
        from presets_meta import update_preset_meta

        bpm = payload.get("bpm")
        key_tonic = payload.get("key_tonic")
        key_mode = payload.get("key_mode")
        title = payload.get("title")
        thumbnail_url = payload.get("thumbnail_url")

        update_preset_meta(
            DATA_DIR,
            id=preset_id,
            bpm=float(bpm) if bpm is not None else None,
            key_tonic=str(key_tonic) if key_tonic is not None else None,
            key_mode=str(key_mode) if key_mode is not None else None,
            title=str(title) if title is not None else None,
            thumbnail_url=str(thumbnail_url) if thumbnail_url is not None else None,
        )
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"meta update failed: {e}")


@app.post("/bpm/{task_id}/detect")
async def bpm_detect(task_id: str):
    out_dir, _v, _m, _video = output_paths(task_id)
    stems = find_stems(out_dir)
    if not stems:
        raise HTTPException(status_code=404, detail="Stems not ready")

    # Prefer drums stem for detection
    wav = stems.get("drums") or stems.get("other") or stems.get("vocals")
    if not wav:
        raise HTTPException(status_code=404, detail="No stem available")

    source = "drums" if stems.get("drums") else ("other" if stems.get("other") else "vocals")

    try:
        from bpm_detect import detect_bpm_and_offset_from_wav

        bpm, start_offset = detect_bpm_and_offset_from_wav(wav)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"BPM detect failed: {e}")

    if bpm is None:
        raise HTTPException(status_code=422, detail="Could not detect BPM")

    return {"ok": True, "bpm": bpm, "source": source, "start_offset": start_offset}


@app.post("/key/{task_id}/detect")
async def key_detect(task_id: str):
    out_dir, _v, _m, _video = output_paths(task_id)
    stems = find_stems(out_dir)
    if not stems:
        raise HTTPException(status_code=404, detail="Stems not ready")

    # Prefer harmonic content: other/piano/guitar, avoid drums
    wav = stems.get("other") or stems.get("piano") or stems.get("guitar") or stems.get("vocals")
    if not wav:
        raise HTTPException(status_code=404, detail="No stem available")

    source = "other" if stems.get("other") else ("piano" if stems.get("piano") else ("guitar" if stems.get("guitar") else "vocals"))

    try:
        from key_detect import detect_key_from_wav

        res = detect_key_from_wav(wav)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Key detect failed: {e}")

    if not res:
        raise HTTPException(status_code=422, detail="Could not detect key")

    tonic, mode, conf = res
    return {"ok": True, "tonic": tonic, "mode": mode, "confidence": conf, "source": source}


@app.post("/export/{task_id}")
async def export_mix(task_id: str, payload: dict = Body(default={})):  # noqa: B008
    """Export current mix settings to an mp3 and return a URL under /audio.

    Payload example:
      {
        "mode": {"kind":"master"} | {"kind":"vocal"} | {"kind":"instrument","instrument":"drums"},
        "masterVolume": 100,
        "instrumentalMaster": 100,
        "stemVolumes": {"vocals":100, "drums":100, ...},
        "focusVol": 100,
        "otherInstVol": 100,
        "vocalsVol": 100,
        "instrumentsVol": 100
      }
    """
    out_dir, _v, _m, _video = output_paths(task_id)
    stems = find_stems(out_dir)
    if not stems:
        raise HTTPException(status_code=404, detail="Stems not ready")

    mode = payload.get("mode") or {"kind": "master"}
    kind = str(mode.get("kind") or "master")
    instrument = str(mode.get("instrument") or "")

    master = float(payload.get("masterVolume", 100)) / 100.0
    master = max(0.0, min(1.0, master))

    # Compute per-stem linear gains
    gains: dict[str, float] = {}

    if kind == "master":
        inst_master = float(payload.get("instrumentalMaster", 100)) / 100.0
        inst_master = max(0.0, min(1.0, inst_master))
        stem_vols = payload.get("stemVolumes") or {}
        for nm in stems.keys():
            sv = float(stem_vols.get(nm, 100)) / 100.0
            sv = max(0.0, min(1.0, sv))
            if nm == "vocals":
                gains[nm] = master * sv
            else:
                gains[nm] = master * inst_master * sv

    elif kind == "vocal":
        vocals_vol = max(0.0, min(1.0, float(payload.get("vocalsVol", 100)) / 100.0))
        inst_vol = max(0.0, min(1.0, float(payload.get("instrumentsVol", 100)) / 100.0))
        for nm in stems.keys():
            if nm == "vocals":
                gains[nm] = master * vocals_vol
            else:
                gains[nm] = master * inst_vol

    elif kind == "instrument":
        focus_vol = max(0.0, min(1.0, float(payload.get("focusVol", 100)) / 100.0))
        other_vol = max(0.0, min(1.0, float(payload.get("otherInstVol", 100)) / 100.0))
        vocals_vol = max(0.0, min(1.0, float(payload.get("vocalsVol", 100)) / 100.0))
        for nm in stems.keys():
            if nm == "vocals":
                gains[nm] = master * vocals_vol
            elif instrument and nm == instrument:
                gains[nm] = master * focus_vol
            else:
                gains[nm] = master * other_vol
    else:
        raise HTTPException(status_code=400, detail="Invalid mode")

    # Output path (stable for same mode)
    safe_kind = kind.replace("/", "_")
    safe_inst = instrument.replace("/", "_")
    tag = safe_kind + (f"_{safe_inst}" if safe_inst else "")
    export_dir = os.path.join(DATA_DIR, task_id, "exports")
    out_mp3 = os.path.join(export_dir, f"mix_{tag}.mp3")

    try:
        from export_mix import mixdown_to_mp3

        mixdown_to_mp3(stems, gains, out_mp3)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export failed: {e}")

    return {"ok": True, "mp3": f"/audio/{task_id}/exports/mix_{tag}.mp3"}


@app.delete("/presets/{preset_id}")
async def presets_delete(preset_id: str):
    """Delete a preset and its associated cached files (video/audio/transpose) if present."""
    deleted = delete_preset(DATA_DIR, preset_id)

    if deleted:
        vid = deleted.get("video_id")
        if vid:
            # remove track DB row too (cached separation)
            try:
                delete_track(DATA_DIR, str(vid))
            except Exception:
                pass

            # move files aside (safer than rm) under data/_deleted
            try:
                task_id = hashlib.sha1(str(vid).encode("utf-8")).hexdigest()[:16]
                src_dir = os.path.join(DATA_DIR, task_id)
                if os.path.exists(src_dir):
                    import time, shutil
                    dst_root = os.path.join(DATA_DIR, "_deleted")
                    os.makedirs(dst_root, exist_ok=True)
                    dst_dir = os.path.join(dst_root, f"{task_id}_{int(time.time())}")
                    shutil.move(src_dir, dst_dir)
            except Exception:
                pass

    return {"ok": True, "deleted": bool(deleted)}


# -----------------------------
# Transpose (offline, cached)
# -----------------------------

def transposed_paths(task_id: str, semitones: int):
    out_dir = os.path.join(DATA_DIR, task_id, f"transpose_{semitones:+d}")
    # 입력이 flac이면 flac으로 출력 (ffmpeg은 확장자로 코덱 결정)
    base_dir, base_v, base_m, _video_file = output_paths(task_id)
    v_ext = os.path.splitext(base_v)[1] or ".flac"
    m_ext = os.path.splitext(base_m)[1] or ".flac"
    vocals = os.path.join(out_dir, f"vocals{v_ext}")
    no_vocals = os.path.join(out_dir, f"no_vocals{m_ext}")
    return out_dir, vocals, no_vocals


def transposed_stems_dir(task_id: str, semitones: int) -> str:
    return os.path.join(DATA_DIR, task_id, f"transpose_{semitones:+d}")


def ensure_transposed(task_id: str, semitones: int):
    base_dir, base_v, base_m, _video_file = output_paths(task_id)
    if not os.path.exists(base_v) or not os.path.exists(base_m):
        raise HTTPException(status_code=404, detail="Base audio not ready")

    out_dir, tv, tm = transposed_paths(task_id, semitones)
    os.makedirs(out_dir, exist_ok=True)

    if os.path.exists(tv) and os.path.exists(tm):
        return out_dir, tv, tm

    # Pitch factor (2^(n/12))
    factor = 2 ** (float(semitones) / 12.0)
    inv = 1.0 / factor

    import subprocess

    def run(src: str, dst: str):
        # Prefer Rubber Band (R3 engine + formant preservation) for much better quality.
        rb = shutil.which("rubberband") or ""
        if rb:
            # -3 fine engine, -F formant, --centre-focus for stereo, -q quiet
            subprocess.run(
                [
                    rb,
                    "-3",
                    "-F",
                    "--centre-focus",
                    "-q",
                    "-t",
                    "1.0",
                    "-p",
                    str(semitones),
                    src,
                    dst,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return

        # Fallback: ffmpeg asetrate+atempo (faster, lower quality)
        # Keep within atempo supported range (0.5-2.0) by chaining if needed
        at = inv
        at_filters = []
        while at < 0.5:
            at_filters.append("atempo=0.5")
            at /= 0.5
        while at > 2.0:
            at_filters.append("atempo=2.0")
            at /= 2.0
        at_filters.append(f"atempo={at:.6f}")

        af = f"asetrate=44100*{factor:.8f},aresample=44100," + ",".join(at_filters)
        subprocess.run(
            [
                ffmpeg_bin(),
                "-y",
                "-i",
                src,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-af",
                af,
                dst,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    run(base_v, tv)
    run(base_m, tm)
    return out_dir, tv, tm


@app.post("/transpose/{task_id}")
async def transpose(task_id: str, semitones: int = 0):
    # UI supports only +/-6 to keep quality reasonable and avoid heavy processing
    if abs(int(semitones)) > 6:
        raise HTTPException(status_code=400, detail="semitones out of range (-6..6)")

    out_dir, _v, _m, video_file = output_paths(task_id)
    base_stems = find_stems(out_dir)

    # Prefer multi-stem transpose when available
    if base_stems:
        if semitones == 0:
            stems_rel = {k: os.path.relpath(v, DATA_DIR) for k, v in base_stems.items()}
        else:
            from transpose_stems import ensure_transposed_stems

            set_task(task_id, status="processing", stage="transposing", progress=0)

            def _prog(p: int):
                set_task(task_id, status="processing", stage="transposing", progress=int(p))

            _od, stems_rel = await run_in_threadpool(
                ensure_transposed_stems,
                data_dir=DATA_DIR,
                task_id=task_id,
                semitones=int(semitones),
                stems=base_stems,
                progress_cb=_prog,
            )

            set_task(task_id, status="completed", stage="completed", progress=100)

        # return as API-style urls
        stems_api = {k: f"/audio/{v}" for k, v in stems_rel.items()}
        return {
            "task_id": task_id,
            "semitones": int(semitones),
            "stems": stems_api,
            "video": f"/audio/{task_id}/video.mp4" if os.path.exists(video_file) else None,
        }

    # Fallback: legacy 2-stem transpose
    if semitones == 0:
        output_dir, vocals_file, no_vocals_file, _video_file = output_paths(task_id)
        if not (os.path.exists(vocals_file) and os.path.exists(no_vocals_file)):
            raise HTTPException(status_code=404, detail="Base audio not ready")
        base = os.path.basename(output_dir)
        return {
            "task_id": task_id,
            "semitones": 0,
            "vocals": f"/audio/{base}/htdemucs/original/{os.path.basename(vocals_file)}",
            "no_vocals": f"/audio/{base}/htdemucs/original/{os.path.basename(no_vocals_file)}",
        }

    # ensure_transposed runs rubberband/ffmpeg and can block; run it off the event loop
    out_dir2, tv, tm = await run_in_threadpool(ensure_transposed, task_id, int(semitones))
    rel = os.path.relpath(out_dir2, DATA_DIR)
    return {
        "task_id": task_id,
        "semitones": int(semitones),
        "vocals": f"/audio/{rel}/{os.path.basename(tv)}",
        "no_vocals": f"/audio/{rel}/{os.path.basename(tm)}",
    }




# -----------------------------
# Lyrics (LRC) — LRCLIB import / manual paste / edit / fetch
# -----------------------------
from lyrics_store import (
    parse_lrc,
    serialize_lrc,
    lrclib_get,
    lrclib_search,
    load_lrc,
    save_lrc,
    lyrics_path,
    lrc_to_yaml,
)
from db import delete_preset_lyrics


@app.get("/lyrics/{video_id}")
async def lyrics_get(video_id: str):
    """저장된 가사 반환. 없으면 404 (프론트는 '가져오기' 버튼 노출)."""
    text = load_lrc(DATA_DIR, video_id)
    if text is None:
        raise HTTPException(status_code=404, detail="no lyrics saved")
    parsed = parse_lrc(text)
    return {
        "video_id": video_id,
        "lrc": text,
        "meta": parsed["meta"],
        "lines": parsed["lines"],
        "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
    }


@app.put("/lyrics/{video_id}")
async def lyrics_put(video_id: str, payload: dict = Body(default={})):  # noqa: B008
    """LRC 텍스트 저장 (직접 붙여넣기 또는 편집). body: {lrc: "..."} 또는 {lines:[...], meta:{...}}"""
    lrc_text = payload.get("lrc")
    if lrc_text is None:
        lines = payload.get("lines")
        if lines is None:
            raise HTTPException(status_code=400, detail="provide 'lrc' or 'lines'")
        lrc_text = serialize_lrc(payload.get("meta") or {}, lines)
    if not str(lrc_text).strip():
        raise HTTPException(status_code=400, detail="empty lyrics")
    save_lrc(DATA_DIR, video_id, str(lrc_text))
    parsed = parse_lrc(str(lrc_text))
    return {
        "ok": True,
        "lines": parsed["lines"],
        "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
    }


@app.delete("/lyrics/{video_id}")
async def lyrics_delete(video_id: str):
    if load_lrc(DATA_DIR, video_id) is None:
        raise HTTPException(status_code=404, detail="no lyrics saved")
    delete_preset_lyrics(DATA_DIR, video_id)
    try:
        os.remove(lyrics_path(DATA_DIR, video_id))  # 구버전 파일 잔존 시 제거
    except FileNotFoundError:
        pass
    return {"ok": True}


# -----------------------------
# Chords (코드악보) — 직접 입력/편집 전용 (외부 DB 없음)
# -----------------------------
from chords_store import parse_chords, serialize_chords, load_chords, save_chords
from db import delete_preset_chords


@app.get("/chords/{video_id}")
async def chords_get(video_id: str):
    """저장된 코드 반환. 없으면 404. lines는 줄 단위 그룹핑: [{time, chords:[{time,text}]}]"""
    text = load_chords(DATA_DIR, video_id)
    if text is None:
        raise HTTPException(status_code=404, detail="no chords saved")
    parsed = parse_chords(text)
    return {
        "video_id": video_id,
        "lrc": text,
        "meta": parsed["meta"],
        "lines": parsed["lines"],
        "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
    }


@app.put("/chords/{video_id}")
async def chords_put(video_id: str, payload: dict = Body(default={})):  # noqa: B008
    """코드 LRC 텍스트 저장. body: {lrc: "..."} 또는 {lines:[...], meta:{...}}"""
    lrc_text = payload.get("lrc")
    if lrc_text is None:
        lines = payload.get("lines")
        if lines is None:
            raise HTTPException(status_code=400, detail="provide 'lrc' or 'lines'")
        lrc_text = serialize_chords(payload.get("meta") or {}, lines)
    if not str(lrc_text).strip():
        raise HTTPException(status_code=400, detail="empty chords")
    save_chords(DATA_DIR, video_id, str(lrc_text))
    parsed = parse_chords(str(lrc_text))
    return {
        "ok": True,
        "lines": parsed["lines"],
        "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
    }


@app.delete("/chords/{video_id}")
async def chords_delete(video_id: str):
    if load_chords(DATA_DIR, video_id) is None:
        raise HTTPException(status_code=404, detail="no chords saved")
    delete_preset_chords(DATA_DIR, video_id)
    return {"ok": True}


@app.post("/lyrics/{video_id}/stamp")
async def lyrics_stamp(video_id: str, payload: dict = Body(default={})):  # noqa: B008
    """빈 스탬프 찍기 — 재생 중 현재 위치의 타임스탬프를 기록.

    body: {position_sec: 83.4}  (프론트에서 현재 재생 위치 전달)
    동작: 저장된 LRC에(없으면 새로 생성) `[mm:ss.xx]` 빈 줄을 시간순으로 추가.
    나중에 편집기에서 해당 줄에 텍스트를 채워 넣는 수동 싱크 워크플로용.
    """
    pos = payload.get("position_sec")
    if pos is None:
        raise HTTPException(status_code=400, detail="position_sec required")
    try:
        t = max(0.0, float(pos))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="position_sec must be a number")

    text = load_lrc(DATA_DIR, video_id) or ""
    parsed = parse_lrc(text)  # 메타(offset 등)와 기존 줄 모두 보존
    parsed["lines"].append({"time": round(t, 3), "text": ""})
    parsed["lines"].sort(key=lambda x: x["time"])

    new_text = serialize_lrc(parsed["meta"], parsed["lines"])
    save_lrc(DATA_DIR, video_id, new_text)
    mm = int(t // 60)
    ss = t - mm * 60
    return {
        "ok": True,
        "stamp": f"[{mm:02d}:{ss:05.2f}]",
        "total_lines": len(parsed["lines"]),
        "empty_stamps": sum(1 for ln in parsed["lines"] if not ln["text"]),
        "lines": parsed["lines"],
        "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
        "lrc": new_text,
    }


@app.post("/lyrics/{video_id}/import")
async def lyrics_import(video_id: str, payload: dict = Body(default={})):  # noqa: B008
    """LRCLIB에서 가져오기.

    body:
      {title, artist, duration?}  → 정확 매칭(/api/get) 시도 → 실패 시 검색 결과 목록 반환
      {candidate_id}              → 검색 결과에서 선택해 저장
      {q}                         → 자유 검색
    반환:
      saved: true  → 저장 완료 (lines 포함)
      candidates: [...]  → 매칭 실패, 사용자 선택 필요
    """
    title = (payload.get("title") or "").strip()
    artist = (payload.get("artist") or "").strip()
    duration = payload.get("duration")
    q = (payload.get("q") or "").strip()
    candidate_id = payload.get("candidate_id")

    def _save_from(rec: dict) -> dict:
        sl = rec.get("syncedLyrics")
        if not sl:
            raise HTTPException(status_code=422, detail="이 후보에는 동기화 가사가 없습니다 (일반 가사만 있음)")
        if candidate_id or payload.get("force_save"):
            # 검색 결과의 LRC는 헤더 태그 없는 경우가 많아 메타 보강
            sl = f"[ti:{rec.get('trackName','')}]\n[ar:{rec.get('artistName','')}]\n" + sl
        save_lrc(DATA_DIR, video_id, sl)
        parsed = parse_lrc(sl)
        return {"ok": True, "saved": True, "lines": parsed["lines"],
                "offset_ms": int(parsed["meta"].get("offset", 0) or 0),
                "source": {"id": rec.get("id"), "artist": rec.get("artistName"), "title": rec.get("trackName"), "duration": rec.get("duration")}}

    # 1) 후보 선택 저장
    if candidate_id:
        cands = lrclib_search(q=q) if q else lrclib_search(artist=artist, title=title)
        for rec in cands:
            if str(rec.get("id")) == str(candidate_id):
                return _save_from(rec)
        raise HTTPException(status_code=404, detail="candidate not found (search again)")

    # 2) 정확 매칭 (duration 있을 때 유리)
    if title and artist:
        try:
            rec = lrclib_get(artist=artist, title=title, duration=float(duration) if duration else None)
        except Exception:
            rec = None
        if rec and rec.get("syncedLyrics"):
            return _save_from(rec)

    # 3) 검색 후보 목록 반환
    try:
        cands = lrclib_search(artist=artist, title=title, q=q) if (artist or title or q) else []
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LRCLIB 검색 실패: {e}")

    def _brief(rec: dict) -> dict:
        return {
            "id": rec.get("id"),
            "artist": rec.get("artistName"),
            "title": rec.get("trackName"),
            "album": rec.get("albumName"),
            "duration": rec.get("duration"),
            "synced": bool(rec.get("syncedLyrics")),
            "word_sync": bool(rec.get("hasWordSync")),
            "preview": ((rec.get("syncedLyrics") or rec.get("plainLyrics") or "").splitlines() or [""])[0][:80],
        }

    return {"saved": False, "candidates": [_brief(r) for r in cands[:10]]}


@app.get("/lyrics/{video_id}/yaml")
async def lyrics_yaml(video_id: str):
    """LRCLIB lyricsfile 호환 YAML로 내보내기 (향후 chord 확장 대비)."""
    text = load_lrc(DATA_DIR, video_id)
    if text is None:
        raise HTTPException(status_code=404, detail="no lyrics saved")
    parsed = parse_lrc(text)
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(
        lrc_to_yaml(parsed["lines"], parsed["meta"]),
        media_type="application/x-yaml",
    )


# -----------------------------
# Static frontend serving (Next.js out/ — 단일 프로세스 배포)
# -----------------------------
FRONTEND_DIST = os.environ.get(
    "HOLY_FRONTEND_DIST",
    os.path.join(os.path.dirname(__file__), "..", "frontend", "out"),
)

if os.path.isdir(FRONTEND_DIST):
    assets_dir = os.path.join(FRONTEND_DIST, "_next")
    if os.path.isdir(assets_dir):
        app.mount("/_next", StaticFiles(directory=assets_dir), name="next_assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        # 삭제된 API 경로(/lyrics, /resync 등)는 SPA 폴백 대신 404 — 프론트가 HTML을 파싱하는 일 방지
        removed_api = {"resync"}
        first_seg = full_path.split("/")[0]
        if first_seg in removed_api:
            raise HTTPException(status_code=404, detail="Not found")
        # /library, /settings 등 클라이언트 라우트 → 해당 디렉터리 index.html
        # (단, trailing slash 없는 /library는 API JSON 라우트가 먼저 매칭됨)
        candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
        if full_path and candidate.startswith(os.path.abspath(FRONTEND_DIST)):
            if os.path.isfile(candidate):
                return FileResponse(candidate)
            idx = os.path.join(candidate, "index.html")
            if os.path.isfile(idx):
                return FileResponse(idx)
        fallback = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.isfile(fallback):
            return FileResponse(fallback)
        raise HTTPException(status_code=404, detail="frontend not built — run install.sh")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
