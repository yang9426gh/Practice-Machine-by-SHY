# Practice Machine by SHY - uninstaller
# 사용법: UNINSTALL.bat (대화형) / powershell -File windows_uninstall.ps1 -KeepData / -All
param(
    [switch]$KeepData,
    [switch]$All
)
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$dataDir = Join-Path $Backend "data"

Write-Host "🎤 Practice Machine by SHY 제거"
& (Join-Path $Root "windows_stop.ps1")

function Ask([string]$q) {
    $a = Read-Host "$q [Y/n]"
    if ($a -eq "" -or $a -match "^[Yy]") { return $true } else { return $false }
}

$sizeGB = 0
if (Test-Path $dataDir) {
    $sum = (Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($sum) { $sizeGB = [math]::Round($sum / 1GB, 1) }
}

if ($All) {
    $delRuntime = $true; $delData = $true; $delFolder = $true
} elseif ($KeepData) {
    $delRuntime = $true; $delData = $false; $delFolder = $false
} else {
    $delRuntime = Ask "런타임 삭제 (venv·빌드 캐시 — 재설치 때 다시 받아짐)"
    $delData    = (Ask "곡·스템 데이터 삭제 ($sizeGB GB)")
    $delFolder  = Ask "폴더 전체 삭제"
}

if ($delRuntime) {
    Remove-Item (Join-Path $Backend "venv") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Root "frontend\node_modules") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Root "frontend\.next") -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✔ 런타임 삭제 완료"
}
if ($delData) {
    Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✔ 곡 데이터 삭제 완료"
}
if ($delFolder) {
    if ((-not $delData) -and (Test-Path $dataDir)) {
        $dest = Join-Path $HOME "Practice-Machine-data-backup"
        Move-Item $dataDir $dest -Force
        Write-Host "✔ 곡 데이터 백업 이동: $dest"
    }
    Set-Location $HOME
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✔ 폴더 삭제 완료"
}
Write-Host "✅ 제거 완료"
