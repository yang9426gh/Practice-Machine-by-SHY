# Practice Machine by SHY - stop server
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$pidFile = Join-Path $Backend "run.pid"
$stopped = $false

if (Test-Path $pidFile) {
    $p = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($p) {
        Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# pid 파일이 오래됐거나 없을 때 포트 기반 정리
$Port = 8011
$settings = Join-Path $Backend "settings.env"
if (Test-Path $settings) {
    foreach ($line in Get-Content $settings) {
        if ($line -match "^\s*HOLY_PORT\s*=\s*(.+)$") { $Port = [int]$Matches[1].Trim() }
    }
}
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    $stopped = $true
}

if ($stopped) { Write-Host "✅ 서버를 종료했습니다." }
else { Write-Host "실행 중인 서버가 없습니다." }
