# =============================================================================
# Savvey: push V.57 + V.58 in sequence.
#   V.57 - suppress misleading price on check_elsewhere verdict
#   V.58 - friendly empty state when no Amazon match
#
# RUN:
#   cd "C:\Users\vince\OneDrive\Desktop\files for live"
#   powershell -ExecutionPolicy Bypass -File PUSH-ALL-V57-V58.ps1
# =============================================================================
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo

$scripts = @(
    'APPLY88-wave-v57.ps1',
    'APPLY89-wave-v58.ps1'
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
Write-Host "  V.57 + V.58 attempted" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
