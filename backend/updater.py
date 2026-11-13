"""Self-update module — 앱 내 원클릭 코드 업데이트 (v1.7.0).

설계:
- Drive에 상주하는 manifest(version.json)와 코드 zip의 파일 ID는 **고정** —
  배포 시 files.update로 내용만 제자리 갱신하므로 이 코드의 URL은 영구 유효.
- apply: zip 다운로드 → sha256 검증 → 스테이징 추출 → 보호경로(곡 데이터/venv/설정)
  제외 오버레이 → 마커 기록 → 서버 재시작(launchd면 종료만, KeepAlive가 부활;
  패키지 설치면 포트가 닫힐 때까지 기다렸다 launcher.sh 재실행).
- stdlib only (urllib/json/zipfile/hashlib/subprocess) — 의존성 다이어트 규칙 준수.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/.. = 앱 폴더

MANIFEST_URL = os.environ.get(
    "HOLY_UPDATE_MANIFEST_URL",
    "https://github.com/yang9426gh/Practice-Machine-by-SHY/releases/latest/download/manifest.json",
)

LAUNCHD_LABEL = "com.holy.karaoke"

# 업데이트 zip이 절대 덮어쓰면 안 되는 것 (곡 데이터·런타임·설정·로그·개발물)
PROTECTED = {
    "backend/data", "backend/venv", "backend/runtime", "backend/settings.env",
    "backend/run.log", "backend/run.err", "backend/run.pid",
    "backend/update_marker.json",
    "launcher.log", "toggle.log", ".git", "dist", "tools", ".DS_Store",
}

# 통째로 교체하는 디렉터리 (빌드 산출물 — 스테일 파일 방지 위해 wipe 후 교체)
WIPE_REPLACE_DIRS = {"frontend/out"}

MARKER_PATH = os.path.join(ROOT, "backend", "update_marker.json")


def current_version() -> str:
    pkg = os.path.join(ROOT, "frontend", "package.json")
    try:
        with open(pkg, "r", encoding="utf-8") as f:
            return str(json.load(f).get("version", "?"))
    except Exception:
        return "?"


def _http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "PracticeMachine-Updater"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_manifest() -> dict:
    data = _http_get(MANIFEST_URL, timeout=15)
    return json.loads(data.decode("utf-8"))


def version_tuple(v: str):
    parts = []
    for x in str(v).split("."):
        if x.isdigit():
            parts.append(int(x))
        else:
            break
    return tuple(parts) if parts else (0,)


def check_update() -> dict:
    m = fetch_manifest()
    latest = str(m.get("version", "")).strip()
    cur = current_version()
    return {
        "current": cur,
        "latest": latest,
        "update_available": version_tuple(latest) > version_tuple(cur),
        "notes": m.get("notes", ""),
        "released_at": m.get("released_at", ""),
    }


def _is_protected(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    if rel.startswith("./"):
        rel = rel[2:]
    if rel in PROTECTED:
        return True
    for p in PROTECTED:
        if rel.startswith(p + "/"):
            return True
    return False


def _download_zip(manifest: dict, dest: str) -> None:
    url = manifest.get("zip_url") or (
        "https://drive.usercontent.google.com/download?id=%s&export=download&confirm=t"
        % manifest.get("zip_file_id", "")
    )
    data = _http_get(url, timeout=300)
    if data[:2] != b"PK":
        raise RuntimeError("다운로드한 파일이 zip이 아님 (Drive 오류 페이지 가능성)")
    expected = str(manifest.get("sha256", "")).lower()
    if expected:
        got = hashlib.sha256(data).hexdigest()
        if got != expected:
            raise RuntimeError(f"sha256 불일치 (기대 {expected[:12]}… / 실제 {got[:12]}…)")
    with open(dest, "wb") as f:
        f.write(data)


def apply_update() -> dict:
    manifest = fetch_manifest()
    old_version = current_version()
    tmp_zip = os.path.join(tempfile.gettempdir(), f"pm_update_{manifest.get('version', 'x')}.zip")
    stage = tempfile.mkdtemp(prefix="pm_update_stage_")
    try:
        _download_zip(manifest, tmp_zip)
        with zipfile.ZipFile(tmp_zip) as z:
            z.extractall(stage)
        # 필수 구조 검증
        for req in ("backend/main.py", "frontend/out/index.html", "frontend/package.json"):
            if not os.path.isfile(os.path.join(stage, req)):
                raise RuntimeError(f"업데이트 zip 손상 — {req} 없음")
        stage_version = ""
        vp = os.path.join(stage, "VERSION")
        if os.path.isfile(vp):
            stage_version = open(vp, encoding="utf-8").read().strip()
        if stage_version and stage_version != str(manifest.get("version", "")).strip():
            raise RuntimeError(f"버전 불일치 (manifest {manifest.get('version')} / zip {stage_version})")

        # 통째 교체 디렉터리: wipe 후 복사 (스테일 청크 방지)
        for d in WIPE_REPLACE_DIRS:
            src = os.path.join(stage, d)
            dst = os.path.join(ROOT, d)
            if os.path.isdir(src):
                if os.path.isdir(dst):
                    shutil.rmtree(dst)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copytree(src, dst)

        # 나머지: 개별 파일 오버레이 (보호경로 스킵)
        copied = 0
        for dirpath, _dirnames, filenames in os.walk(stage):
            for fn in filenames:
                src = os.path.join(dirpath, fn)
                rel = os.path.relpath(src, stage)
                if rel.replace("\\", "/").split("/")[0] + "/" in {d + "/" for d in WIPE_REPLACE_DIRS}:
                    continue  # 이미 통째 교체됨
                if _is_protected(rel):
                    continue
                dst = os.path.join(ROOT, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                copied += 1

        # backend 스테일 .py 제거 — 새 zip에 없는 기존 최상위 .py 삭제 (삭제된 모듈 잔존 방지)
        stage_py = {
            fn for fn in os.listdir(os.path.join(stage, "backend"))
            if fn.endswith(".py")
        } if os.path.isdir(os.path.join(stage, "backend")) else set()
        removed = []
        backend_dir = os.path.join(ROOT, "backend")
        if os.path.isdir(backend_dir):
            for fn in os.listdir(backend_dir):
                if fn.endswith(".py") and fn not in stage_py:
                    try:
                        os.remove(os.path.join(backend_dir, fn))
                        removed.append(fn)
                    except OSError:
                        pass

        marker = {
            "from": old_version,
            "to": str(manifest.get("version", "")),
            "finished_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
            "files": copied,
            "removed_stale": removed,
            "ok": True,
        }
        with open(MARKER_PATH, "w", encoding="utf-8") as f:
            json.dump(marker, f, ensure_ascii=False, indent=1)
        return marker
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        try:
            os.remove(tmp_zip)
        except OSError:
            pass


def _launchd_managed() -> bool:
    try:
        return subprocess.run(
            ["launchctl", "list", LAUNCHD_LABEL],
            capture_output=True,
        ).returncode == 0
    except Exception:
        return False


def schedule_restart(delay: float = 2.0) -> bool:
    t = threading.Timer(delay, _do_restart)
    t.daemon = True
    t.start()
    return True


def _do_restart() -> None:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    mode = os.environ.get("HOLY_UPDATE_RESTART", "auto")  # auto | launchd | bash
    if mode != "bash" and _launchd_managed():
        os._exit(0)  # launchd KeepAlive가 새 코드로 재기동
    if sys.platform == "win32":
        # START.bat이 포트 점유 프로세스를 먼저 정리하므로 곧바로 재기동 가능
        subprocess.Popen(
            ["cmd", "/c", "start", "", "START.bat"],
            cwd=ROOT, shell=False,
            creationflags=0x00000008,  # DETACHED_PROCESS
        )
    else:
        # 포트가 완전히 닫힌 뒤 launcher.sh 재실행 (이미-실행중 분기에 안 걸리도록)
        port = os.environ.get("HOLY_PORT", "8011")
        inner = (
            'while curl -s -o /dev/null --max-time 1 "http://127.0.0.1:%s/" 2>/dev/null; '
            'do sleep 0.5; done; sleep 0.5; exec bash "$0/launcher.sh"' % port
        )
        subprocess.Popen(["bash", "-c", inner, ROOT], cwd=ROOT, start_new_session=True)
    os._exit(0)
