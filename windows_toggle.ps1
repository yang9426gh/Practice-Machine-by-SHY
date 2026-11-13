# Practice Machine by SHY - 외부접속 켜기/끄기 토글
# 켜기: 서버를 0.0.0.0 으로 재시작 (같은 와이파이 폰/태블릿 접속 가능)
# 끄기: 서버를 127.0.0.1 로 재시작 (이 컴퓨터 전용, 기본값)
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$settings = Join-Path $Backend "settings.env"

$cur = "127.0.0.1"
if (Test-Path $settings) {
    foreach ($line in Get-Content $settings) {
        if ($line -match "^\s*HOLY_HOST\s*=\s*(.+)$") { $cur = $Matches[1].Trim() }
    }
}
if ($cur -eq "0.0.0.0") { $new = "127.0.0.1" } else { $new = "0.0.0.0" }
# 기존 설정(HOLY_PORT 등) 유지 — HOLY_HOST 줄만 교체/추가
$lines = @(Get-Content $settings -ErrorAction SilentlyContinue)
$found = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*HOLY_HOST\s*=") { $lines[$i] = "HOLY_HOST=$new"; $found = $true; break }
}
if (-not $found) { $lines += "HOLY_HOST=$new" }
Set-Content -Path $settings -Value $lines -Encoding ASCII
Write-Host "바인딩 변경: $cur → $new (서버 재시작 중...)"

# 재시작 (stop → start)
& (Join-Path $Root "windows_stop.ps1")
Start-Sleep -Seconds 1
& (Join-Path $Root "windows_start.ps1")

# 안내 팝업 (120초 후 자동 닫힘)
$Port = 8011
foreach ($line in Get-Content $settings) {
    if ($line -match "^\s*HOLY_PORT\s*=\s*(.+)$") { $Port = [int]$Matches[1].Trim() }
}
$wsh = New-Object -ComObject WScript.Shell
if ($new -eq "0.0.0.0") {
    $ip = $null
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254)" } |
            Select-Object -First 1).IPAddress
    } catch { }
    if (-not $ip) { $ip = "(IP를 못 찾았습니다 — cmd에서 ipconfig 실행)" }
    $wsh.Popup("외부접속 켜짐`n`n같은 와이파이 기기(폰·태블릿)에서 접속:`nhttp://$ip`:$Port`n`n(이 창은 120초 후 저절로 닫힙니다)", 120, "Practice Machine by SHY - 외부접속") | Out-Null
} else {
    $wsh.Popup("외부접속 꺼짐 — 이 컴퓨터에서만 접속 가능합니다.", 30, "Practice Machine by SHY - 외부접속") | Out-Null
}
