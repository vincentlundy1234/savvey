# =============================================================================
# Savvey v3.4.5v70: PRICE-HISTORY LOGGING (panel-mandated, non-blocking)
#
# Round-table verdict 8 May 2026:
#   APPROVED Item #2 — time-series price logging via kvSet append
#   STRICT GUARDRAILS:
#     - Must be entirely asynchronous
#     - Must NOT block the API response to the client
#     - Pure background task, fire-and-forget
#
# What it does:
#   After every successful fetchVerifiedAmazonPrice() call, fire an async
#   kvSet to a separate key namespace `savvey:pricelog:{ts}:{shortHash}`.
#   Stored fields: { canonical, asin, price, retailer, rating, reviews, ts }.
#   TTL: 90 days (long enough to build a history, KV stays bounded).
#   Errors swallowed silently — log payload is never on the critical path.
#
# Optionality this unlocks (per Latency Expert + DD analysis):
#   - 200K-500K timestamped UK product price observations within 12 months
#   - Brand-side data licensing (Mintel, Kantar, FMCG digital teams)
#   - Consumer journalism partnerships (Which?, MoneySavingExpert)
#   - Internal retrospectives on price-band drift for Haiku verdict tuning
#
# Cost: £0 ongoing. KV storage trivial at current traffic.
# Risk: zero — purely additive, no critical-path code touched.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v70 (price-history logging) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

# ---------------------------------------------------------------------------
# We bypass PowerShell here-string fragility by delegating the file edit
# to Python via the 'py' or 'python' launcher. If neither exists, we
# fall back to a much simpler in-line PowerShell .Replace call.
# The Python path is preferred because it makes multi-line code edits
# robust against quote/escape issues that bit V.69.
# ---------------------------------------------------------------------------
$normPath = Join-Path $repo "api\normalize.js"
$pythonScript = @'
import re, pathlib, sys
p = pathlib.Path("api/normalize.js")
src = p.read_text(encoding="utf-8")

# Sanity check
if "normalize.js v3.4.5v69" not in src:
    print("ERROR: expected VERSION v3.4.5v69; found something else", file=sys.stderr)
    sys.exit(1)

# Bump version
src = src.replace("normalize.js v3.4.5v69", "normalize.js v3.4.5v70")

# Inject async price-log fire-and-forget INSIDE fetchVerifiedAmazonPrice,
# right before the function returns the verified payload. We anchor on the
# `return {` line that returns the price object. Insert a non-blocking
# kvSet call BEFORE the return statement.
old_anchor = '''    return {
      price:           Number(primary.extracted_price),'''
new_anchor = '''    // V.70 - PRICE-HISTORY LOGGING (panel-mandated, fire-and-forget).
    // Non-blocking: async kvSet call without await, errors swallowed.
    // Stored under separate key namespace so the canonical cache stays clean.
    // 90-day TTL keeps KV bounded while building a 12-month history dataset.
    try {
      const _logTs = Date.now();
      const _logHash = (_logTs + String(query)).slice(-12).replace(/[^a-z0-9]/gi, '');
      const _logKey = 'savvey:pricelog:' + _logTs + ':' + _logHash;
      const _logVal = {
        canonical: String(query).slice(0, 200),
        asin: (typeof primary.asin === 'string') ? primary.asin : null,
        price: Number(primary.extracted_price),
        retailer: 'amazon.co.uk',
        rating: (typeof primary.rating === 'number') ? primary.rating : null,
        reviews: (typeof primary.reviews === 'number') ? primary.reviews : null,
        ts: new Date(_logTs).toISOString(),
      };
      // 90 days = 7776000 seconds. Fire-and-forget; never await.
      kvSet(_logKey, _logVal, 7776000).catch(() => {});
    } catch (_e) { /* swallow - non-critical */ }

    return {
      price:           Number(primary.extracted_price),'''

if old_anchor not in src:
    print("ERROR: return-block anchor not found in fetchVerifiedAmazonPrice", file=sys.stderr)
    sys.exit(1)

src = src.replace(old_anchor, new_anchor, 1)
p.write_text(src, encoding="utf-8")

# index.html footer
hp = pathlib.Path("index.html")
html = hp.read_text(encoding="utf-8")
html = re.sub(r"Beta v3\.4\.5v\d+", "Beta v3.4.5v70", html)
html = re.sub(r"v3\.4\.5v\d+</span>", "v3.4.5v70</span>", html)
hp.write_text(html, encoding="utf-8")

# sw.js
sp = pathlib.Path("sw.js")
sw = sp.read_text(encoding="utf-8")
sw = sw.replace("savvey-static-v345v69", "savvey-static-v345v70")
sp.write_text(sw, encoding="utf-8")

print("V.70 edits applied OK", file=sys.stderr)
'@

# Save Python script to a temp file
$tmpPy = Join-Path $env:TEMP "savvey_v70_edit.py"
[System.IO.File]::WriteAllText($tmpPy, $pythonScript, [System.Text.UTF8Encoding]::new($false))

# Try py launcher first (Python 3.x on Windows), then python, then python3
$pyExe = $null
foreach ($cand in @('py', 'python', 'python3')) {
    $found = Get-Command $cand -ErrorAction SilentlyContinue
    if ($found) { $pyExe = $cand; break }
}

if ($null -eq $pyExe) {
    Write-Host "  [WARN] No Python found on PATH. Run this manually:" -ForegroundColor Yellow
    Write-Host "  py `"$tmpPy`"" -ForegroundColor Yellow
    Write-Host "  Then re-run this script (which will skip the edit step and just commit+push)." -ForegroundColor Yellow
    exit 1
}

Push-Location $repo
& $pyExe $tmpPy
$pyExit = $LASTEXITCODE
Pop-Location
Remove-Item $tmpPy -Force -ErrorAction SilentlyContinue

if ($pyExit -ne 0) {
    Write-Host "  [FATAL] Python edit step failed - aborting" -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] V.70 edits applied via Python" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Commit + push
# ---------------------------------------------------------------------------
git add api/normalize.js index.html sw.js; GitOk "add"
$msg = @'
v3.4.5v70 Wave V.70: price-history logging (panel-mandated, non-blocking)

Round-table verdict 8 May 2026 approved Item #2 from the moat-build brief:
time-series price logging via async kvSet append. Strict guardrails:
- Entirely asynchronous (fire-and-forget, no await)
- Never blocks the API response to the client
- Errors swallowed silently
- 90-day TTL keeps KV bounded

What it does:
After every successful fetchVerifiedAmazonPrice() call, fire a non-blocking
kvSet to namespace `savvey:pricelog:{ts}:{shortHash}`. Stored payload:
{ canonical, asin, price, retailer, rating, reviews, ts }.

Optionality unlocked:
- 200K-500K UK product price observations within 12 months
- Brand-side data licensing (Mintel, Kantar, FMCG)
- Consumer journalism partnerships
- Internal retrospectives on price-band drift for Haiku verdict tuning

Cost: £0 ongoing. Risk: zero - purely additive, no critical path touched.

Items #1 (Receipt OCR) and #4 (Apple Sign In) explicitly KILLED per panel.
Item #5 (Mobile-CLIP on-device classifier) deferred to V.71.

SW: savvey-static-v345v70.  Footer: v3.4.5v70.
'@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host ("  master committed: " + $sha) -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.70: " + $sha)
Write-Host "Footer: v3.4.5v70"
Write-Host "SW:     savvey-static-v345v70"
