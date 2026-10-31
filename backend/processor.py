import os
import shutil
import sys
import subprocess
import time
from typing import Callable, Optional


def _terminate_proc(proc: subprocess.Popen) -> None:
    """취소 시 자식 프로세스 확실히 정리 — terminate→wait→kill 계단식.
    wait 없이 두면 좀비 프로세스 잔존 + stdout 파이프(파일디스크립터) 누수."""
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    except Exception:
        pass
    finally:
        try:
            if proc.stdout:
                proc.stdout.close()
        except Exception:
            pass


def find_node() -> str:
    """node 런타임 탐색 — .app(Finder/launchd) 실행 시 PATH가 /usr/bin:/bin 뿐이라
    Homebrew node를 못 찾는 문제 대응. 절대경로 후보를 직접 확인."""
    found = shutil.which("node")
    if found:
        return found
    for p in (
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "C:\\Program Files\\nodejs\\node.exe",        # Windows
        "C:\\Program Files (x86)\\nodejs\\node.exe",  # Windows (32bit 빌드)
        os.path.expanduser("~/.nvm/versions/node"),   # nvm은 최신 버전 디렉토리 스캔
        os.path.expanduser("~/AppData/Roaming/nvm"),  # nvm-windows도 디렉토리 스캔
    ):
        if os.path.isfile(p):
            return p
        if os.path.isdir(p):
            try:
                vers = sorted(os.listdir(p))
                if vers:
                    for cand in (
                        os.path.join(p, vers[-1], "bin", "node"),  # nvm (macOS/Linux)
                        os.path.join(p, vers[-1], "node.exe"),     # nvm-windows
                    ):
                        if os.path.isfile(cand):
                            return cand
            except Exception:
                pass
    return ""


def _ffmpeg_location() -> str:
    """yt-dlp postprocessing용 ffmpeg 위치.

    이걸 yt-dlp에 넘겨주지 않으면 PATH에 ffmpeg이 없는 환경(.app 실행 등)에서
    다운로드 자체는 끝나지만 'Postprocessing: ffprobe and ffmpeg not found'로
    실패한다. imageio-ffmpeg 번들 바이너리(venv 안)를 우선 사용.
    """
    try:
        from ffmpeg_locate import ffmpeg_bin

        return ffmpeg_bin()
    except Exception:
        return shutil.which("ffmpeg") or ""


def _raise_cmd_error(rc: int, cmd: list, log_tail: str = "") -> None:
    """CalledProcessError에 실제 실패 로그 꼬리를 붙임 — UI에서 진단 가능하게.
    log_tail 없이 던지면 'Command [...' 만 보여서 원인을 알 수 없음."""
    msg = f"Command {cmd!r} returned non-zero exit status {rc}."
    if log_tail:
        tail = "\n".join(log_tail.strip().splitlines()[-8:])
        msg += f"\n--- yt_dlp 출력 마지막 부분 ---\n{tail}"
    raise RuntimeError(msg)


def download_youtube_audio(
    url: str,
    output_path: str,
    *,
    cancel_cb: Optional[Callable[[], bool]] = None,
    proc_cb: Optional[Callable[[subprocess.Popen], None]] = None,
    progress_cb: Optional[Callable[[int], None]] = None,
) -> str:
    print(f"[*] Downloading audio from: {url}")
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-check-certificate",
    ]

    # Optional: use cookies from a local browser profile to avoid bot checks.
    # Enable by setting HOLY_YTDLP_COOKIES_FROM_BROWSER=chrome|edge|firefox|safari
    cfb = os.environ.get("HOLY_YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if cfb:
        cmd += ["--cookies-from-browser", cfb]

    # Optional: enable JS runtime for signature/challenge solving.
    # Without it, some videos show: "Only images are available" / "Requested format is not available".
    # Enable by setting HOLY_YTDLP_JS_RUNTIMES=node|deno|bun|node:/path/to/node
    jsr = os.environ.get("HOLY_YTDLP_JS_RUNTIMES", "").strip()
    if jsr == "":
        # 기본 node — PATH에 없으면 절대경로 직접 탐색(.app 실행 시 PATH가 좁음)
        node = find_node()
        jsr = f"node:{node}" if node else ""
    if jsr:
        cmd += ["--js-runtimes", jsr]

    # EJS remote components can be required for JS challenge solving on YouTube.
    # Default to enabling; can be disabled by setting HOLY_YTDLP_REMOTE_COMPONENTS="".
    rc = os.environ.get("HOLY_YTDLP_REMOTE_COMPONENTS", "ejs:github").strip()
    if rc:
        cmd += ["--remote-components", rc]

    ffl = _ffmpeg_location()
    if ffl:
        cmd += ["--ffmpeg-location", ffl]

    cmd += [
        "-x",
        "--audio-format",
        "wav",
        "-o",
        f"{output_path}/original.%(ext)s",
        url,
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
    )
    if proc_cb:
        proc_cb(proc)

    import re
    pct_re = re.compile(r"\[download\]\s+(\d{1,3}(?:\.\d+)?)%")

    log_buf: list = []  # 실패 시 UI에 보여줄 로그 꼬리
    while True:
        if cancel_cb and cancel_cb():
            _terminate_proc(proc)
            raise RuntimeError("cancelled")

        line = proc.stdout.readline() if proc.stdout else ""
        if line:
            print(line, end="")
            log_buf.append(line)
            if len(log_buf) > 40:
                log_buf.pop(0)
            m = pct_re.search(line)
            if m and progress_cb:
                try:
                    progress_cb(int(float(m.group(1))))
                except Exception:
                    pass

        if line == "" and proc.poll() is not None:
            break

        time.sleep(0.01)

    rc = proc.wait()
    if rc != 0:
        _raise_cmd_error(rc, cmd, "".join(log_buf))

    return f"{output_path}/original.wav"

def download_youtube_video(
    url: str,
    output_path: str,
    *,
    max_height: int = 720,
    cancel_cb: Optional[Callable[[], bool]] = None,
    proc_cb: Optional[Callable[[subprocess.Popen], None]] = None,
    progress_cb: Optional[Callable[[int], None]] = None,
) -> str:
    """Download a playable MP4 for local <video> playback."""
    out = os.path.join(output_path, "video.mp4")
    if os.path.exists(out) and os.path.getsize(out) > 1024 * 1024:
        if progress_cb:
            progress_cb(100)
        return out

    print(f"[*] Downloading video from: {url}")
    fmt = (
        f"bestvideo[height<={max_height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"best[height<={max_height}][ext=mp4]/best[height<={max_height}]"
    )

    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-check-certificate",
    ]

    cfb = os.environ.get("HOLY_YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if cfb:
        cmd += ["--cookies-from-browser", cfb]

    # Optional: enable JS runtime for signature/challenge solving.
    jsr = os.environ.get("HOLY_YTDLP_JS_RUNTIMES", "").strip()
    if jsr == "":
        node = find_node()
        jsr = f"node:{node}" if node else ""
    if jsr:
        cmd += ["--js-runtimes", jsr]

    rc = os.environ.get("HOLY_YTDLP_REMOTE_COMPONENTS", "ejs:github").strip()
    if rc:
        cmd += ["--remote-components", rc]

    ffl = _ffmpeg_location()
    if ffl:
        cmd += ["--ffmpeg-location", ffl]

    cmd += [
        "-f",
        fmt,
        "--merge-output-format",
        "mp4",
        "-o",
        out,
        url,
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
    )
    if proc_cb:
        proc_cb(proc)

    import re
    pct_re = re.compile(r"\[download\]\s+(\d{1,3}(?:\.\d+)?)%")

    log_buf: list = []  # 실패 시 UI에 보여줄 로그 꼬리
    while True:
        if cancel_cb and cancel_cb():
            _terminate_proc(proc)
            raise RuntimeError("cancelled")

        line = proc.stdout.readline() if proc.stdout else ""
        if line:
            print(line, end="")
            log_buf.append(line)
            if len(log_buf) > 40:
                log_buf.pop(0)
            m = pct_re.search(line)
            if m and progress_cb:
                try:
                    progress_cb(int(float(m.group(1))))
                except Exception:
                    pass

        if line == "" and proc.poll() is not None:
            break

        time.sleep(0.01)

    rc = proc.wait()
    if rc != 0:
        _raise_cmd_error(rc, cmd, "".join(log_buf))

    if progress_cb:
        progress_cb(100)
    return out



def separate_stems(
    input_file: str,
    output_dir: str,
    task_id: str | None = None,
    progress_cb=None,
    *,
    model_name: str = "htdemucs_6s",
    cancel_cb: Optional[Callable[[], bool]] = None,
    proc_cb: Optional[Callable[[subprocess.Popen], None]] = None,
):
    print(f"[*] Separating stems using AI (Demucs model={model_name})...")
    t0 = time.time()

    base_cmd = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--name",
        model_name,
        "--flac",  # 무손실 압축 저장 (WAV 대비 ~50%, 품질 동일)
        "-o",
        output_dir,
    ]

    # Try Apple Silicon acceleration (MPS) first; if it fails, fall back to CPU.
    cmd = base_cmd + ["--device", "mps", input_file]
    print(f"[*] Demucs cmd (try mps): {' '.join(cmd)}")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
    )
    if proc_cb:
        proc_cb(proc)

    import re

    percent_re = re.compile(r"(\d{1,3})%\|")

    last_percent = None
    while True:
        if cancel_cb and cancel_cb():
            _terminate_proc(proc)
            raise RuntimeError("cancelled")

        chunk = proc.stdout.readline() if proc.stdout else ""
        if chunk == "" and proc.poll() is not None:
            break
        if not chunk:
            continue

        m = percent_re.search(chunk)
        if m:
            try:
                p = int(m.group(1))
                if progress_cb and p != last_percent and 0 <= p <= 100:
                    progress_cb(p)
                last_percent = p
            except Exception:
                pass

        print(chunk, end="")

    rc = proc.wait()
    if rc != 0:
        # MPS might not be available depending on torch build; retry on CPU once.
        cmd2 = base_cmd + [input_file]
        print(f"[!] Demucs mps failed (rc={rc}). Retrying on CPU: {' '.join(cmd2)}")
        proc2 = subprocess.Popen(
            cmd2,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )
        if proc_cb:
            proc_cb(proc2)

        last_percent = None
        log_buf2: list = []  # 실패 시 UI에 보여줄 로그 꼬리
        while True:
            if cancel_cb and cancel_cb():
                _terminate_proc(proc2)
                raise RuntimeError("cancelled")

            chunk = proc2.stdout.readline() if proc2.stdout else ""
            if chunk == "" and proc2.poll() is not None:
                break
            if not chunk:
                continue

            log_buf2.append(chunk)
            if len(log_buf2) > 40:
                log_buf2.pop(0)

            m = percent_re.search(chunk)
            if m:
                try:
                    p = int(m.group(1))
                    if progress_cb and p != last_percent and 0 <= p <= 100:
                        progress_cb(p)
                    last_percent = p
                except Exception:
                    pass

            print(chunk, end="")

        rc2 = proc2.wait()
        if rc2 != 0:
            _raise_cmd_error(rc2, cmd2, "".join(log_buf2))

    if progress_cb:
        progress_cb(100)

    dt = time.time() - t0
    print(f"[+] Separation completed! ({dt:.1f}s)")

if __name__ == "__main__":
    # 테스트용 (유튜브 URL을 인자로 받음)
    if len(sys.argv) > 1:
        yt_url = sys.argv[1]
        target_dir = "./data/test_run"
        os.makedirs(target_dir, exist_ok=True)

        orig_file = download_youtube_audio(yt_url, target_dir)
        separate_stems(orig_file, target_dir)
    else:
        print("Usage: python3 processor.py <youtube_url>")
