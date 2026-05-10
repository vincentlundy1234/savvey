# =============================================================================
# Savvey v3.4.5v75: Principal UI/UX Architect sweep
# - Bug A: orphan in-flight fetch on screen change (ghost results)
# - Bug B: rapid double-tap on Snap fires getUserMedia twice
# - Bug C: stale lastResult on home re-entry
# - Bug D: V.68 entrance animation re-fire jank
# Files touched: index.html + sw.js (no backend changes).
# Uses git commit -F to avoid PowerShell arg-splitting on multi-line msg.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v75 (UI/UX architect sweep - state hygiene) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

git add index.html sw.js; GitOk "add"

$msgFile = Join-Path $env:TEMP "savvey_v75_commit_msg.txt"
$msg = @'
v3.4.5v75 Wave V.75: UI/UX architect sweep - state hygiene + animation polish

Autonomous Principal UI/UX Architect protocol: surgical sweep across
3 mandate buckets (touch targets, animations, state bleed). Four real
bugs killed, all in index.html + one cache bump in sw.js.

BUG A - ORPHAN IN-FLIGHT FETCH (state bleed, HIGH severity)
callNormalize() created an AbortController but never aborted it on
screen change. User flow: tap Snap, wait 2s, tap Home. Old fetch
continues for another 4s, lands on home screen as a ghost result
panel. Now fixed: AbortController hoisted to module scope as
_savveyActiveAbort, abort() called inside show() whenever target
is not 'loading'. Belt-and-braces sequence number (_savveyFetchSeq)
also added so a stale response that races past abort() still gets
dropped before render. New PostHog event: normalize_stale_dropped
+ normalize_aborted (separate from normalize_throw).

BUG B - DOUBLE-TAP RACE ON SNAP DOOR (state bleed, MEDIUM)
goSnap() had no reentrancy guard. Rapid double-tap fired
getUserMedia() twice in parallel, leaving an orphaned MediaStream
holding the camera light on and draining battery. Fixed with
_savveyCameraStarting flag + short-circuit if a live stream
already exists.

BUG C - STALE lastResult ON HOME RE-ENTRY (state bleed, LOW)
Returning to home via show('home') never cleared window.lastResult,
which meant a back-button history pop or late-arriving render could
resurface yesterday's verdict. Now nulled defensively.

BUG D - V.68 ENTRANCE ANIMATION RE-FIRE JANK (animation, MEDIUM)
Rapid Home -> Snap -> Home interrupted .screen.active keyframes
mid-animation and looked broken. Throttle: if same screen reactivated
within 400ms, skip the .active toggle dance. Tracked via
_savveyLastShownAt timestamp map.

NO BACKEND CHANGES.
NO API SCHEMA CHANGES.
SW: savvey-static-v345v75.  Footer: v3.4.5v75.
'@

[System.IO.File]::WriteAllText($msgFile, $msg, [System.Text.UTF8Encoding]::new($false))

git commit -F $msgFile
$commitExit = $LASTEXITCODE
Remove-Item $msgFile -Force -ErrorAction SilentlyContinue

if ($commitExit -ne 0) {
    Write-Host "FATAL: git commit failed (perhaps no changes to commit)" -ForegroundColor Red
    exit 1
}

$sha = (git rev-parse --short HEAD).Trim()
Write-Host ("  master committed: " + $sha) -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.75: " + $sha)
Write-Host "Footer: v3.4.5v75"
Write-Host "SW:     savvey-static-v345v75"
Write-Host ""
Write-Host "After Vercel deploys (~30s), verify:" -ForegroundColor Cyan
Write-Host "  1. Tap Snap, then immediately tap Home before result lands." -ForegroundColor Cyan
Write-Host "     No ghost result panel should appear on home." -ForegroundColor Cyan
Write-Host "  2. Double-tap Snap door rapidly. Camera should start once," -ForegroundColor Cyan
Write-Host "     no second getUserMedia prompt." -ForegroundColor Cyan
Write-Host "  3. Run a query, return to Home, navigate around. Old verdict" -ForegroundColor Cyan
Write-Host "     never resurfaces." -ForegroundColor Cyan
Write-Host "  4. Bounce Home -> Snap -> Home rapidly. Entrance animations" -ForegroundColor Cyan
Write-Host "     should not flicker or restart mid-animation." -ForegroundColor Cyan
