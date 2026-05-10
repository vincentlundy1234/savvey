# =============================================================================
# Savvey v3.4.5v59 INLINE patch + push.
# Self-contained: edits index.html + sw.js directly, no staging folder.
# Run from C:\Users\vince\OneDrive\Desktop\files for live\
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo

function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w' failed" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v59 INLINE (restore V.53 padding) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim()
GitOk "branch read"
git checkout master | Out-Null
GitOk "checkout master"
git pull origin master
GitOk "pull"

# --- Patch index.html ---
$html = Get-Content "index.html" -Raw -Encoding UTF8

# Footer version bump
$html = $html.Replace('Beta &middot; v3.4.5v58', 'Beta &middot; v3.4.5v59')
$html = $html.Replace('Beta · v3.4.5v58', 'Beta · v3.4.5v59')

# 1. Welcome screen padding 44px -> 88px + add overflow-y: auto
$oldWelcome = "    margin: -16px;`r`n    padding: 36px 28px 44px;`r`n    min-height: 100dvh;`r`n    display: none;`r`n    flex-direction: column;`r`n    box-sizing: border-box;`r`n  }"
$newWelcome = "    margin: -16px;`r`n    /* V.59 (re-applies V.53): bottom padding 44 -> 88 so 'I'll have a browse' CTA isn't clipped by GDPR banner. */`r`n    padding: 36px 28px 88px;`r`n    min-height: 100dvh;`r`n    display: none;`r`n    flex-direction: column;`r`n    box-sizing: border-box;`r`n    /* V.59: allow scroll on shorter viewports */`r`n    overflow-y: auto;`r`n  }"
if ($html.Contains($oldWelcome)) {
    $html = $html.Replace($oldWelcome, $newWelcome)
    Write-Host "  [OK] welcome padding 44 -> 88 + overflow-y" -ForegroundColor Green
} else {
    # Try LF version (some editors normalise)
    $oldWelcomeLF = $oldWelcome -replace "`r`n", "`n"
    $newWelcomeLF = $newWelcome -replace "`r`n", "`n"
    if ($html.Contains($oldWelcomeLF)) {
        $html = $html.Replace($oldWelcomeLF, $newWelcomeLF)
        Write-Host "  [OK] welcome padding 44 -> 88 + overflow-y (LF)" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] welcome anchor not found - already applied or markup drift" -ForegroundColor Yellow
    }
}

# 2. Confirm screen padding 24 -> 100
if ($html.Contains("padding: 8px 0 24px;")) {
    $html = $html.Replace("padding: 8px 0 24px;", "/* V.59 (re-applies V.53): nav clearance */`r`n    padding: 8px 0 100px;")
    Write-Host "  [OK] confirm padding 24 -> 100" -ForegroundColor Green
} else {
    Write-Host "  [WARN] confirm anchor not found" -ForegroundColor Yellow
}

# 3. Home wrap padding 20 -> 100
if ($html.Contains("padding: 8px 18px 20px;")) {
    $html = $html.Replace("padding: 8px 18px 20px;", "/* V.59 (re-applies V.53): clears bottom nav (88px + safe-area) */`r`n    padding: 8px 18px 100px;")
    Write-Host "  [OK] home wrap padding 20 -> 100" -ForegroundColor Green
} else {
    Write-Host "  [WARN] home wrap anchor not found" -ForegroundColor Yellow
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

# --- Patch sw.js ---
$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v58", "savvey-static-v345v59")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v59" -ForegroundColor Green

# --- Commit + push ---
git add index.html sw.js
GitOk "add"

$msg = @"
v3.4.5v59 Wave V.59: HOTFIX - restore V.53 padding fixes (V.54-58 stomped them)

Process bug found during full audit. V.53's three padding fixes were
silently reverted by V.54 onwards because each subsequent wave's patch
script started from a stale local snapshot (v51 baseline).

Live audit: .v5-home-wrap computed paddingBottom is '20px' on v3.4.5v58.
Type door Search button at y=687, bottom nav top y=659 - 28px BEHIND nav.

Restored:
1. #screen-welcome: padding 44 -> 88 + overflow-y: auto (clears GDPR)
2. .v5-confirm-screen: padding 24 -> 100 (clears nav)
3. .v5-home-wrap: padding 20 -> 100 (Type door Search button visible)

NO ENGINE CHANGES. NO BACKEND CHANGES.
SW: bumped STATIC_VER to savvey-static-v345v59.
Footer: v3.4.5v59.
"@
git commit -m $msg
GitOk "commit"

$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green

git push origin master
GitOk "push"

if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.59: " + $sha + " (V.53 padding restored)")
Write-Host "Footer:    v3.4.5v59"
Write-Host "SW:        savvey-static-v345v59"
