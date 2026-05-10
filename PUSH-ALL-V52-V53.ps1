# =============================================================================
# Savvey: push V.52 + V.53 in sequence.
#   V.52 — KV cache prefix bump (instant flush of EUR-cached entries)
#   V.53 — layout fix (Type/Confirm/Welcome bottom nav clearance)
#
# RUN:
#   cd "C:\Users\vince\OneDrive\Desktop\files for live"
#   powershell -ExecutionPolicy Bypass -File PUSH-ALL-V52-V53.ps1
# =============================================================================
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo

$scripts = @(
    'APPLY83-wave-v52.ps1',
    'APPLY84-wave-v53.ps1'
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
Write-Host "  V.52 + V.53 attempted" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
