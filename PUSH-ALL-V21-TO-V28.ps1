# =============================================================================
# Savvey: push V.21 -> V.28 in sequence. One command for all 8 waves.
#
# RUN:
#   cd "C:\Users\vince\OneDrive\Desktop\files for live"
#   powershell -ExecutionPolicy Bypass -File PUSH-ALL-V21-TO-V28.ps1
# =============================================================================
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo

$scripts = @(
    'APPLY53-wave-v21.ps1',
    'APPLY54-wave-v22.ps1',
    'APPLY55-wave-v23.ps1',
    'APPLY56-wave-v24.ps1',
    'APPLY57-wave-v25.ps1',
    'APPLY58-wave-v26.ps1',
    'APPLY59-wave-v27.ps1',
    'APPLY60-wave-v28.ps1'
)

foreach ($s in $scripts) {
    Write-Host ""
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Running $s" -ForegroundColor Cyan
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    $p = Join-Path $repo $s
    if (-not (Test-Path $p)) {
        Write-Host "  [SKIP] $s not found (already cleaned or never staged)" -ForegroundColor Yellow
        continue
    }
    & powershell -ExecutionPolicy Bypass -File $p
    Start-Sleep -Milliseconds 800
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  ALL DONE — V.21 through V.28 attempted" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
