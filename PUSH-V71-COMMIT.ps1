# =============================================================================
# Savvey v3.4.5v71 BUNDLE: Quick Wins #1-#5 + V.70 price logging
#
# All file edits ALREADY APPLIED via bash+Python (clean OneDrive sync).
# This script just commits + pushes.
#
# Bundle contents:
#   - V.70 (Item #2 panel-approved): price-history logging, async kvSet,
#     fire-and-forget, never blocks API response. 90-day TTL.
#   - QW3 Web Share Target API: manifest.json share_target expanded to capture
#     url + text + title. JS auto-routes shared payload to Paste door (URL) or
#     Type door (text). Savvey now appears in iOS/Android system share sheets.
#   - QW2 Trust-theatre loading: phase-aware narration during cold-path wait.
#     "Reading the label..." -> "Checking Amazon UK live price..." -> etc.
#     setTimeout-driven, advances on screen-loading.active mutation.
#   - QW4 A2HS install prompt: captures beforeinstallprompt, defers reveal
#     until first good_buy/fair verdict (the trust moment), 5.2s after pill
#     pop. Custom in-page sheet, dismissable, decision persisted.
#   - QW1 Last 3 Snaps strip: localStorage-backed horizontal-scroll on home,
#     thumb + title + verdict-tone dot, tap re-runs through canonical cache
#     (~80ms). Habit-loop seed.
#   - QW5 Restocking smart chip: frequency math on per-product visit history,
#     surfaces "Restocking X?" when due (predicted-interval +/- 5d window).
#     Category-default fallback for first-time entries (grocery 7d, health 30d,
#     etc). Dismissible (7-day snooze).
#
# Cost: zero. No backend, no auth, no schema, no new deps. Pure frontend +
# manifest + one async kvSet line in normalize.js. Mobile-CLIP (V.72) remains
# parked for the dedicated session per panel mandate.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v71 (Quick Wins bundle + price logging) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

# All edits already applied via bash+Python. Just stage + commit + push.
git add api/normalize.js index.html manifest.json sw.js; GitOk "add"

$msg = @'
v3.4.5v71 Wave V.71: Quick Wins bundle (5) + V.70 price logging

Six features in one push, all panel-approved or panel-aligned:

V.70 PRICE-HISTORY LOGGING (panel-approved Item #2)
- Async kvSet append after every successful fetchVerifiedAmazonPrice
- Fire-and-forget, never blocks API response
- 90-day TTL keeps KV bounded; builds 12-month dataset
- Cost: zero. Optionality: brand-side data licensing, journalism partnerships

QW3 WEB SHARE TARGET API
- manifest.json share_target expanded: { title, text, url }
- JS auto-routes shared payload: URL -> Paste door (goLink), text -> Type door (goText)
- Savvey now appears in iOS/Android system share sheets
- Distribution unlock: any product link from any app -> 1-tap to verdict

QW2 TRUST-THEATRE LOADING NARRATION
- Phase-aware status text on the 4-phase loading timeline:
  "Reading the label." -> "Checking Amazon UK live price." ->
  "Comparing UK retailers." -> "Drafting your verdict."
- setTimeout-driven (0/800/2200/3200ms) on screen-loading.active
- Stops on screen change. Pure CSS class toggling, no backend.

QW4 SMART A2HS INSTALL PROMPT
- Captures beforeinstallprompt event silently
- Triggers ONLY after first good_buy / fair verdict (the trust moment)
- 5.2s after verdict pill pop animation completes
- Custom in-page sheet, backdrop tap dismisses
- Decision persisted in localStorage (savvey_a2hs_decided)

QW1 LAST 3 SNAPS STRIP (the actual habit loop)
- localStorage-backed horizontal scroll strip on home
- Inserted between greeting and first door
- Thumb (verified Amazon thumbnail) + title + verdict-tone dot
- Tap re-runs through canonical cache (~80ms = feels instant)
- Dedup by canonical, max 12 entries, top 6 displayed
- Skips low-confidence results

QW5 RESTOCKING SMART CHIP
- Per-product visit history in localStorage (savvey_snap_history)
- Frequency math: 2+ visits = use observed avg interval
- 1 visit = use category default (grocery 7d, health 30d, beauty 30d,
  home 60d, tech 365d, diy 90d, toys 365d)
- Surfaces "Restocking X?" chip when (now - lastVisit) is within
  predicted-interval +/- 5 days window
- Sorted by closest-to-predicted, top 1 shown
- Dismissable with 7-day snooze

All wired via window.renderResult function-proxy (one wrap, idempotent
via __v71Wrapped flag). Both new features render on screen-home class
mutation so they refresh after every navigation back to home.

NO ENGINE CHANGES (price log is non-blocking).
NO AUTH, NO SCHEMA, NO NEW DEPS.
SW: savvey-static-v345v71.  Footer: v3.4.5v71.
'@

git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host ("  master committed: " + $sha) -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.71: " + $sha)
Write-Host "Footer: v3.4.5v71"
Write-Host "SW:     savvey-static-v345v71"
Write-Host ""
Write-Host "Verify after Vercel redeploys (~30s):" -ForegroundColor Cyan
Write-Host "  1. /api/health -> deploy = $sha" -ForegroundColor Cyan
Write-Host "  2. Snap or Type a product to see Last 3 Snaps strip seed on home" -ForegroundColor Cyan
Write-Host "  3. Loading screen narrates phases instead of static tagline" -ForegroundColor Cyan
Write-Host "  4. Trigger a 'Good buy' verdict, wait 5s, A2HS prompt should appear (mobile)" -ForegroundColor Cyan
Write-Host "  5. Share a product link from any app to Savvey -> auto-routes" -ForegroundColor Cyan
