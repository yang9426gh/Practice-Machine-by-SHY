# Practice Machine by SHY - start server + open browser
$ErrorActionPreference = "SilentlyContinue"
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$VenvPy = Join-Path $Backend "venv\Scripts\python.exe"
$wsh = New-Object -ComObject WScript.Shell

if (-not (Test-Path $VenvPy)) {
    Write-Host "❌ 미설치 상태 — 먼저 INSTALL.bat 실행"
    $wsh.Popup("아직 설치되지 않았습니다. 먼저 INSTALL.bat을 실행해 주세요.", 0, "Practice Machine by SHY") | Out-Null
    exit 1
}

# ---------- settings.env 읽기 (외부접속 토글 결과 존중) ----------
$HostBind = "127.0.0.1"
$Port = 8011
$settings = Join-Path $Backend "settings.env"
if (Test-Path $settings) {
    foreach ($line in Get-Content $settings) {
        if ($line -match "^\s*HOLY_HOST\s*=\s*(.+)$") { $HostBind = $Matches[1].Trim() }
        if ($line -match "^\s*HOLY_PORT\s*=\s*(.+)$") { $Port = [int]$Matches[1].Trim() }
    }
}

# ---------- 포트 점유 프로세스 정리 ----------
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
if ($conns) { Start-Sleep -Seconds 1 }

Write-Host "🎤 Practice Machine by SHY 시작 → http://localhost:$Port (바인딩: $HostBind)"
# 자가 업데이트 manifest (파일 ID 고정 — 재배포에도 링크 불변)
$env:HOLY_UPDATE_MANIFEST_URL = "https://drive.usercontent.google.com/download?id=1T8FN6awjqp9oFOxwzkpI-EYuWqWEparR&export=download&confirm=t"
$proc = Start-Process -FilePath $VenvPy `
    -ArgumentList @("-m", "uvicorn", "main:app", "--host", $HostBind, "--port", "$Port") `
    -WorkingDirectory $Backend -WindowStyle Minimized `
    -RedirectStandardOutput (Join-Path $Backend "run.log") `
    -RedirectStandardError (Join-Path $Backend "run.err") -PassThru
Set-Content -Path (Join-Path $Backend "run.pid") -Value $proc.Id

# ---------- 헬스 체크 (최대 ~50초) ----------
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if ($ready) {
    Write-Host "✅ 준비 완료 → http://localhost:$Port (종료: STOP.bat, 로그: backend\run.log)"
    Start-Process "http://localhost:$Port"
} else {
    Write-Host "❌ 서버 기동 실패 — backend\run.log / run.err 확인"
    Start-Process notepad (Join-Path $Backend "run.err")
}
