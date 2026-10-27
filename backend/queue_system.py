"""
Queue system for background video processing.

직렬 처리 큐 (한 번에 1곡만 demucs 실행 — RAM 보호).
- max 5개 대기+실행
- 중복 video_id 방지
- 서버 재시작 시 큐는 휘발성 (stale 상태 정리는 main.py startup에서)
- 완료 시 presets에 자동 등록
"""
import os
import threading
import time
from typing import Dict, List, Optional

MAX_QUEUE = 5

# 큐 항목: {video_id, url, task_id, name(title), thumbnail_url, status, progress, stage, error, added_at}
# status: queued | downloading | separating | processing | completed | error
_QUEUE: List[dict] = []
_QLOCK = threading.Lock()
_WORKER_STARTED = False


def _snapshot(item: dict) -> dict:
    return {
        "video_id": item["video_id"],
        "url": item["url"],
        "task_id": item.get("task_id") or "",
        "name": item.get("name"),
        "thumbnail_url": item.get("thumbnail_url"),
        "status": item["status"],
        "stage": item.get("stage") or "",
        "progress": item.get("progress", 0),
        "error": item.get("error"),
        "added_at": item.get("added_at", 0),
    }


def queue_list() -> List[dict]:
    with _QLOCK:
        return [_snapshot(x) for x in _QUEUE]


def queue_add(video_id: str, url: str, name: Optional[str] = None,
              thumbnail_url: Optional[str] = None) -> dict:
    """큐에 추가. 중복/한도 초과 시 ValueError. 반환: 큐 스냅샷."""
    global _WORKER_STARTED
    with _QLOCK:
        # 완료/에러 항목은 재추가 가능 — 제거 후 넣음
        for x in list(_QUEUE):
            if x["video_id"] == video_id and x["status"] in ("completed", "error"):
                _QUEUE.remove(x)
        if any(x["video_id"] == video_id for x in _QUEUE):
            raise ValueError("already_queued")
        active = sum(1 for x in _QUEUE if x["status"] != "completed")
        if active >= MAX_QUEUE:
            raise ValueError("queue_full")
        item = {
            "video_id": video_id,
            "url": url,
            "task_id": None,
            "name": name,
            "thumbnail_url": thumbnail_url,
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "error": None,
            "added_at": time.time(),
        }
        _QUEUE.append(item)
        snap = _snapshot(item)

    if not _WORKER_STARTED:
        with _QLOCK:
            if not _WORKER_STARTED:
                _WORKER_STARTED = True
                t = threading.Thread(target=_worker_loop, daemon=True, name="holy-queue-worker")
                t.start()
    return snap


def queue_remove(video_id: str) -> bool:
    """대기 중 항목만 제거 가능 (실행 중은 cancel API 사용)."""
    with _QLOCK:
        for x in list(_QUEUE):
            if x["video_id"] == video_id:
                if x["status"] == "queued":
                    _QUEUE.remove(x)
                    return True
                return False
    return False


def queue_clear_completed() -> int:
    with _QLOCK:
        before = len(_QUEUE)
        _QUEUE[:] = [x for x in _QUEUE if x["status"] != "completed"]
        return before - len(_QUEUE)


def queue_update(video_id: str, **patch) -> None:
    with _QLOCK:
        for x in _QUEUE:
            if x["video_id"] == video_id:
                x.update(patch)
                return


def queue_find(video_id: str) -> Optional[dict]:
    with _QLOCK:
        for x in _QUEUE:
            if x["video_id"] == video_id:
                return _snapshot(x)
    return None


# -----------------------------
# Worker (직렬 실행)
# -----------------------------
_worker_wake = threading.Event()


def _worker_loop():
    from main import run_pipeline_sync, set_queue_cb  # late import避免circular

    set_queue_cb(_on_progress)
    while True:
        item = None
        with _QLOCK:
            for x in _QUEUE:
                if x["status"] == "queued":
                    item = x
                    x["status"] = "downloading"
                    x["stage"] = "queued"
                    break
        if item is None:
            _worker_wake.wait(timeout=30)
            _worker_wake.clear()
            continue

        vid = item["video_id"]
        try:
            task_id = run_pipeline_sync(
                item["url"],
                on_stage=lambda stage, prog: _on_progress(vid, stage, prog),
            )
            queue_update(vid, status="completed", stage="completed", progress=100, task_id=task_id)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "cancelled" in msg.lower():
                queue_update(vid, status="error", error="cancelled")
            else:
                queue_update(vid, status="error", error=msg[:300])


def _on_progress(video_id: str, stage: str, progress: int) -> None:
    # 파이프라인 stage → 큐 status 매핑
    if stage in ("downloading_video", "downloading_audio"):
        status = "downloading"
    elif stage == "separating":
        status = "separating"
    else:
        status = "processing"
    queue_update(video_id, status=status, stage=stage, progress=_unified_progress(stage, progress))


# 곡 전체 통합 진행률: 영상 다운로드 0-20 / 오디오 다운로드 20-40 / 스템 분리 40-100
_STAGE_WEIGHTS = {
    "downloading_video": (0, 20),
    "downloading_audio": (20, 40),
    "separating": (40, 100),
}


def _unified_progress(stage: str, progress: int) -> int:
    """단계별 progress(각 0~100)를 곡 전체 0~100으로 환산."""
    lo, hi = _STAGE_WEIGHTS.get(stage, (0, 100))
    p = max(0, min(100, progress))
    return int(lo + (hi - lo) * p / 100)
