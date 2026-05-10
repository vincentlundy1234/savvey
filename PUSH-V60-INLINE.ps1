# =============================================================================
# Savvey v3.4.5v60 INLINE: hide v5-bottom-nav on camera + loading screens.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v60 INLINE (hide v5 nav on camera/loading) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta · v3.4.5v59', 'Beta · v3.4.5v60')

# Replace the broken rule that only targeted .bottom-nav with one that
# targets BOTH .bottom-nav (legacy) and .v5-bottom-nav (current).
$old = "  body:has(#screen-camera.active) .bottom-nav,`r`n  body:has(#screen-loading.active) .bottom-nav { display: none; }"
$new = "  /* V.60: cover both legacy .bottom-nav and current .v5-bottom-nav */`r`n  body:has(#screen-camera.active) .bottom-nav,`r`n  body:has(#screen-camera.active) .v5-bottom-nav,`r`n  body:has(#screen-loading.active) .bottom-nav,`r`n  body:has(#screen-loading.active) .v5-bottom-nav { display: none !important; }"

if ($html.Contains($old)) {
    $html = $html.Replace($old, $new)
    Write-Host "  [OK] camera+loading nav hide rule extended to .v5-bottom-nav" -ForegroundColor Green
} else {
    $oldLF = $old -replace "`r`n", "`n"
    $newLF = $new -replace "`r`n", "`n"
    if ($html.Contains($oldLF)) {
        $html = $html.Replace($oldLF, $newLF)
        Write-Host "  [OK] camera+loading nav hide rule extended (LF)" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] camera+loading nav anchor not found - skipping" -ForegroundColor Yellow
    }
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v59", "savvey-static-v345v60")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v60" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v60 Wave V.60: HOTFIX - hide v5-bottom-nav on camera + loading screens

V.45 v5 BOTTOM-NAV REBUILD changed the nav class from .bottom-nav to
.v5-bottom-nav. V.51 updated the welcome hide rule but camera + loading
hide rules were never updated. Result: full bottom nav (Home/Snap/Scan/
Type) renders over the camera viewfinder + loading screen, breaking
both the immersive snap UX and the loading orbit centerpiece.

Live evidence on v3.4.5v59:
  body:has(#screen-camera.active) matches: true
  document.querySelector('.v5-bottom-nav') computed display: 'grid'
  CSS rule scan for v5-bottom-nav + camera: 0 matches.

FIX: extend the camera + loading hide rule to target BOTH legacy
.bottom-nav AND the current .v5-bottom-nav, with !important to beat
the .v5-bottom-nav grid display rule.

NO ENGINE CHANGES. NO BACKEND CHANGES.
SW: bumped STATIC_VER to savvey-static-v345v60.
Footer: v3.4.5v60.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.60: " + $sha)
Write-Host "Footer: v3.4.5v60"
Write-Host "SW:     savvey-static-v345v60"
