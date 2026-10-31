# Practice Machine by SHY - Windows first-time installer
# Python 3.10+ 가 없으면 winget으로 설치 시도, venv 생성, 의존성 설치.
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VenvPy = Join-Path $Root "backend\venv\Scripts\python.exe"
$wsh = New-Object -ComObject WScript.Shell

Write-Host "============================================"
Write-Host " Practice Machine by SHY - 설치 (최초 1회)"
Write-Host "============================================"

function Invoke-PyCheck([string]$exe, [string]$flag) {
    try {
        if ($flag) { $ver = & $exe $flag -c "import sys; print('%d%02d' % (sys.version_info[:2]))" 2>$null }
        else { $ver = & $exe -c "import sys; print('%d%02d' % (sys.version_info[:2]))" 2>$null }
        if ($LASTEXITCODE -ne 0) { return $null }
        $n = 0
        if (-not [int]::TryParse("$ver".Trim(), [ref]$n)) { return $null }
        if ($n -ge 310) { return @{ exe = $exe; flag = $flag } }
    } catch { }
    return $null
}

# ---------- 1) Python 찾기 ----------
$py = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($f in @("-3.13", "-3.12", "-3.11", "-3.10", "")) {
        $py = Invoke-PyCheck "py" $f
        if ($py) { break }
    }
}
if (-not $py) {
    foreach ($e in @("python", "python3")) {
        if (Get-Command $e -ErrorAction SilentlyContinue) {
            $py = Invoke-PyCheck $e ""
            if ($py) { break }
        }
    }
}

# ---------- 2) 없으면 winget으로 설치 ----------
if (-not $py) {
    Write-Host "📦 Python 없음 — winget으로 설치 시도..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        # 새로 설치된 경로를 현재 세션에 반영
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Get-Command py -ErrorAction SilentlyContinue) { $py = Invoke-PyCheck "py" "-3.12" }
        $py312 = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
        if (-not $py -and (Test-Path $py312)) { $py = @{ exe = $py312; flag = "" } }
    }
    if (-not $py) {
        Write-Host "❌ Python 3.10+ 필요 — https://www.python.org/downloads/ 에서 설치 후 INSTALL.bat 다시 실행"
        $wsh.Popup("Python이 필요합니다. python.org에서 Python 3.12를 설치한 뒤 INSTALL.bat을 다시 실행해 주세요.", 0, "Practice Machine by SHY - 설치 실패") | Out-Null
        exit 1
    }
}
Write-Host "✔ python 확인 완료"

# ---------- 3) venv ----------
if (-not (Test-Path $VenvPy)) {
    Write-Host "📦 Python venv 생성..."
    if ($py.flag) { & $py.exe $py.flag -m venv (Join-Path $Root "backend\venv") }
    else { & $py.exe -m venv (Join-Path $Root "backend\venv") }
    if (-not (Test-Path $VenvPy)) {
        Write-Host "❌ venv 생성 실패"
        $wsh.Popup("venv 생성에 실패했습니다.", 0, "Practice Machine by SHY - 설치 실패") | Out-Null
        exit 1
    }
}

# ---------- 4) 의존성 (PyTorch 포함 — 첫 설치는 몇 분) ----------
& $VenvPy -c "import fastapi, uvicorn, demucs, soundfile, imageio_ffmpeg, yt_dlp" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "📦 의존성 설치 중 (PyTorch 다운로드 포함 — 몇 분 소요)..."
    & $VenvPy -m pip install --upgrade pip
    & $VenvPy -m pip install -r (Join-Path $Root "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 의존성 설치 실패 — 위 로그 확인"
        $wsh.Popup("의존성 설치에 실패했습니다. 창의 로그를 확인해 주세요.", 0, "Practice Machine by SHY - 설치 실패") | Out-Null
        exit 1
    }
} else {
    Write-Host "✔ 의존성 이미 설치됨 — 건너뜀"
}

# ---------- 5) 프론트 빌드물 확인 ----------
if (-not (Test-Path (Join-Path $Root "frontend\out\index.html"))) {
    Write-Host "⚠ frontend\out\index.html 없음 — 이 패키지에는 빌드물이 포함되어 있어야 합니다. (재빌드 안내: 개발자 README 참고)"
}

Write-Host ""
Write-Host "✅ 설치 완료! START.bat 을 실행하세요."
$wsh.Popup("설치가 완료되었습니다. START.bat을 실행해 주세요.", 0, "Practice Machine by SHY - 설치 완료") | Out-Null
