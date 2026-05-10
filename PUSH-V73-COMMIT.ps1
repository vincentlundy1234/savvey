# =============================================================================
# Savvey v3.4.5v73: Mobile-CLIP V2 — backend hint + pre-classify-with-timeout
# (uses git commit -F to avoid PowerShell arg-splitting)
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v73 (Mobile-CLIP V2 - backend hint plumbing) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

git add api/normalize.js index.html sw.js; GitOk "add"

$msgFile = Join-Path $env:TEMP "savvey_v73_commit_msg.txt"
$msg = @'
v3.4.5v73 Wave V.73: Mobile-CLIP V2 - backend hint + pre-classify timeout

Builds on V.72 V1 (which lazy-loads the on-device classifier and runs
it in parallel with /api/normalize). V.73 closes the loop:

BACKEND (api/normalize.js)
- Handler accepts category_hint field on image inputs
- New helper _buildVisionPromptWithHint appends a SOFT constraint to
  Vision tail prompt when hint is present and known-good
  (tech/home/toys/diy/beauty/grocery/health enum, drops generic).
- Hint is explicitly described as "soft signal, not authoritative" so
  Haiku still trusts visible MPN/brand text on the package over the hint.
- Used to break ties on ambiguous packaging (empty containers,
  partial labels) where on-device classifier has more context than text.
- _meta.category_hint_received exposed for diagnostics.

FRONTEND (index.html)
- V.73 fetch interceptor supersedes V.72 (single __v73Wrapped flag).
- Pre-classifies image input BEFORE forwarding fetch via Promise.race
  with 600ms timeout.
  - Cold first-snap: classifier still downloading. 600ms wait, then fires
    without hint. Classifier loads in background for next time.
  - Warm subsequent: classifier cached. ~200-400ms classify, hint applied.
- Confidence-gated: only injects hint when classifier confidence >= 0.55
  AND category != generic.
- Mutates request body before forwarding (JSON.stringify with hint added).
- Also exposes window.__v72ClassifyBase64 + __v72UpdateNarration so V.73
  can re-use V.72's classifier instance (no double load).

NET EFFECT
- Accuracy lift on ambiguous-packaging snaps (empty Listerine bottle,
  generic shampoo container) where on-device sees the broader scene
  context that Haiku can miss from a tight crop.
- Future-ready for V.74+ Haiku-skip optimization (real 1.5s win) once
  hint accuracy is validated in beta data.
- Soft-constraint design means worst case is no behavior change vs V.72,
  best case is improved category lock on hard inputs.

NO ENGINE CHANGES (Vision call signature unchanged, hint via prompt only).
NO BREAKING CHANGES.
SW: savvey-static-v345v73. Footer: v3.4.5v73.
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
Write-Host ("Wave V.73: " + $sha)
Write-Host "Footer: v3.4.5v73"
Write-Host "SW:     savvey-static-v345v73"
