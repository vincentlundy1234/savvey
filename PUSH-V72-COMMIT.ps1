# =============================================================================
# Savvey v3.4.5v72 BUNDLE: 7 features in one push
# (FIXED: uses git commit -F with temp file to avoid PowerShell arg splitting)
#
# All file edits ALREADY APPLIED via bash+Python (clean OneDrive sync).
# This script just commits + pushes.
#
# Bundle contents (panel-approved, stacked):
#   V.70  - Async price-history logging
#   QW1   - Last 3 Snaps strip on home (the habit loop)
#   QW2   - Trust-theatre loading narration
#   QW3   - Web Share Target API
#   QW4   - Smart A2HS install prompt
#   QW5   - Restocking smart chip
#   V.72  - Mobile-CLIP V1 on-device classifier (panel-mandated)
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v72 (7-feature stack, retry) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

# Re-add (idempotent if already staged from prior failed run)
git add api/normalize.js index.html manifest.json sw.js; GitOk "add"

# Write commit message to a temp file so git -F reads it as one string.
# This bypasses PowerShell's native-command-argument-splitting bug that
# fragments multi-line strings passed via -m.
$msgFile = Join-Path $env:TEMP "savvey_v72_commit_msg.txt"
$msg = @'
v3.4.5v72 Wave V.72: 7-feature stack - QuickWins + priceLog + MobileCLIP

ALL panel-approved. One push, seven features.

V.70 PRICE-HISTORY LOGGING (Item #2)
Async kvSet append after every successful fetchVerifiedAmazonPrice.
Fire-and-forget, never blocks API response. 90-day TTL keeps KV bounded.

QW3 WEB SHARE TARGET API
manifest.json share_target expanded with title, text, url.
JS auto-routes shared payload: URL to Paste door, text to Type door.
Savvey now appears in iOS/Android system share sheets.

QW2 TRUST-THEATRE LOADING NARRATION
Phase-aware status text on the 4-phase loading timeline.
Reading the label, Checking Amazon UK, Comparing UK retailers,
Drafting your verdict. setTimeout-driven, advances on screen activation.

QW4 SMART A2HS INSTALL PROMPT
Captures beforeinstallprompt event silently.
Triggers only after first good_buy or fair verdict (trust moment).
5.2s after verdict pop, custom in-page sheet, decision persisted.

QW1 LAST 3 SNAPS STRIP (the actual habit loop)
localStorage-backed horizontal scroll on home.
Thumb + title + verdict-tone dot, tap re-runs canonical (~80ms).
Dedup by canonical, max 12 entries, top 6 displayed.

QW5 RESTOCKING SMART CHIP
Per-product visit history in localStorage.
Frequency math: 2+ visits = avg interval, 1 = category default.
Surfaces Restocking chip in predicted-interval window.
Dismissible with 7-day snooze.

V.72 MOBILE-CLIP V1 (panel-mandated by Performance Engineer)
Lazy-loads HF transformers.js + mobilenet_v2 only on Snap-screen first touch.
Bundle stays near 0KB until camera opens. ~14MB one-time CDN download cached.
Runs in parallel with /api/normalize via fetch interceptor.
Zero added latency to cold path.
ImageNet to 8 retail categories via regex dictionary.
Updates loading-screen narration with category-aware copy on classify.
window.__v72LastCategory exposed for future backend plumbing.
Fully additive. Falls back silently if load fails.
V1 scope: perceived-speed win + future-ready hint plumbing.
V2 deferred: backend Haiku-skip on hint (real 1.5s win), offline-only
degraded mode, confidence-gated direct routing.

No engine changes. No backend changes (price log non-blocking).
No auth, no schema, no new build-time deps.
SW: savvey-static-v345v72. Footer: v3.4.5v72.
'@

[System.IO.File]::WriteAllText($msgFile, $msg, [System.Text.UTF8Encoding]::new($false))

git commit -F $msgFile
$commitExit = $LASTEXITCODE
Remove-Item $msgFile -Force -ErrorAction SilentlyContinue

if ($commitExit -ne 0) {
    Write-Host "FATAL: git commit failed" -ForegroundColor Red
    exit 1
}

$sha = (git rev-parse --short HEAD).Trim()
Write-Host ("  master committed: " + $sha) -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.72: " + $sha)
Write-Host "Footer: v3.4.5v72"
Write-Host "SW:     savvey-static-v345v72"
Write-Host ""
Write-Host "After Vercel deploys (~30s), verify:" -ForegroundColor Cyan
Write-Host "  1. /api/health -> deploy = $sha" -ForegroundColor Cyan
Write-Host "  2. Snap or Type a product, see Last 3 Snaps strip on home" -ForegroundColor Cyan
Write-Host "  3. Loading screen narrates phases (not static tagline)" -ForegroundColor Cyan
Write-Host "  4. After first good_buy verdict, A2HS prompt appears (mobile)" -ForegroundColor Cyan
Write-Host "  5. Open camera, check console for v72 classifier load message" -ForegroundColor Cyan
Write-Host "  6. Share a product link from any app -> Savvey -> auto-routes" -ForegroundColor Cyan
