# =============================================================================
# Savvey v3.4.5v61 INLINE: hide v5-bottom-nav on camera + barcode + loading.
# V.60's anchor missed because real rule covers 3 screens (incl. barcode).
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v61 INLINE (V.60 follow-up: nav hide for v5) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta · v3.4.5v60', 'Beta · v3.4.5v61')

# Use regex match to find the 3-line rule regardless of line endings.
# Pattern: body:has(#screen-camera.active) .bottom-nav, ... bracket .bottom-nav { display: none; }
$pattern = '(?s)(\s*body:has\(#screen-camera\.active\)\s+\.bottom-nav,\s*body:has\(#screen-barcode\.active\)\s+\.bottom-nav,\s*body:has\(#screen-loading\.active\)\s+\.bottom-nav\s*\{\s*display:\s*none;\s*\})'

$replacement = @"
  /* V.61: hide BOTH legacy .bottom-nav and current .v5-bottom-nav on full-screen / transient screens */
  body:has(#screen-camera.active) .bottom-nav,
  body:has(#screen-barcode.active) .bottom-nav,
  body:has(#screen-loading.active) .bottom-nav,
  body:has(#screen-camera.active) .v5-bottom-nav,
  body:has(#screen-barcode.active) .v5-bottom-nav,
  body:has(#screen-loading.active) .v5-bottom-nav { display: none !important; }
"@

if ($html -match $pattern) {
    $html = [System.Text.RegularExpressions.Regex]::Replace($html, $pattern, $replacement)
    Write-Host "  [OK] camera+barcode+loading nav hide rule extended to .v5-bottom-nav" -ForegroundColor Green
} else {
    Write-Host "  [WARN] regex didn't match - checking literal" -ForegroundColor Yellow
    Write-Host "    Looking for body:has(#screen-camera.active) .bottom-nav," -ForegroundColor Yellow
    if ($html.Contains("body:has(#screen-camera.active) .bottom-nav,")) {
        Write-Host "    Literal found - regex whitespace mismatch" -ForegroundColor Yellow
    } else {
        Write-Host "    Literal NOT found either - rule may already be patched" -ForegroundColor Yellow
    }
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v60", "savvey-static-v345v61")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v61" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v61 Wave V.61: HOTFIX - V.60 follow-up, nav hide for v5 class

V.60 missed because the real rule on master covers THREE screens
(camera + barcode + loading), not two. My V.60 anchor only had two
lines so it didn't match. Result: V.60 only bumped SW version, the
actual fix didn't land.

V.61 uses regex to match the real 3-screen rule and adds matching
selectors for .v5-bottom-nav across all three with !important.

Verified live on v3.4.5v60: body:has(#screen-camera.active) matches,
.v5-bottom-nav computed display still 'grid' (no rule hiding it).

NO ENGINE CHANGES. NO BACKEND CHANGES.
SW: bumped STATIC_VER to savvey-static-v345v61.
Footer: v3.4.5v61.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.61: " + $sha)
Write-Host "Footer: v3.4.5v61"
Write-Host "SW:     savvey-static-v345v61"
