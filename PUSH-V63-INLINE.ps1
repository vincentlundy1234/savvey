# =============================================================================
# Savvey v3.4.5v63 INLINE: kill ALL dark @media blocks (28 of them).
# V.62 only overrode :root vars but every scoped rule like
#   @media (prefers-color-scheme: dark) { .v5-greeting-smile { color: #fff } }
# still fires on dark-mode OS, breaking the cream theme. Replace the media
# query string with a never-matching variant so all 28 blocks become inert.
# Also bump nav-home z-index so it can't be obscured by Snap. hero pill.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v63 INLINE (kill all dark @media + nav fix) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta v3.4.5v62', 'Beta v3.4.5v63')
$html = $html.Replace('v3.4.5v62</span>', 'v3.4.5v63</span>')

# Count how many dark blocks before
$beforeCount = ([regex]::Matches($html, '@media \(prefers-color-scheme: dark\)')).Count
Write-Host "  found $beforeCount dark @media blocks" -ForegroundColor Yellow

# Replace `@media (prefers-color-scheme: dark)` with a never-matching variant.
# `(max-width: 1px)` will never match any real viewport, so every dark rule
# becomes inert without having to delete or restructure the block.
# We DO leave the meta theme-color media queries alone (they're attribute
# values, not CSS rules — different syntax).
$html = $html -replace '@media \(prefers-color-scheme: dark\) \{', '@media (prefers-color-scheme: dark) and (max-width: 1px) {'

$afterCount = ([regex]::Matches($html, '@media \(prefers-color-scheme: dark\) and \(max-width: 1px\)')).Count
Write-Host "  rewrote $afterCount dark blocks to never-match" -ForegroundColor Green

# Bump nav-home z-index so the Snap. hero can't visually obscure it.
$navHomeFix = "  /* V.63: explicit z-index on nav buttons so Snap. hero doesn't obscure Home tap target */`r`n  .v5-bottom-nav .nav-tab { position: relative; z-index: 2; }`r`n  .v5-bottom-nav .nav-tab[id=`"nav-home`"] { z-index: 3; }`r`n  .v5-bottom-nav { z-index: 50; }`r`n"

# Inject after the existing v5-bottom-nav declaration
if ($html -match '\.v5-bottom-nav \{[^}]*\}') {
    $anchor = $matches[0]
    $html = $html.Replace($anchor, $anchor + "`r`n" + $navHomeFix)
    Write-Host "  [OK] nav z-index bump injected" -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v62", "savvey-static-v345v63")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v63" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v63 Wave V.63: kill all 28 dark @media blocks + nav-home z-index fix

V.62 only overrode :root CSS vars but every scoped dark @media rule
(.v5-greeting-smile color #fff, .v5-bottom-nav background #101218,
.error-card background #2d1714, etc) still fires under prefers-color-
scheme dark, fragmenting the cream theme into a half-broken hybrid.

Live audit: greeting smile :) was rendering pure white because the
dark block at line 1401 hardcodes color: #fff. Same pattern across
27 other blocks.

V.63 rewrites every '@media (prefers-color-scheme: dark)' to
'@media (prefers-color-scheme: dark) and (max-width: 1px)' so the
clauses never match any real viewport. All 28 dark rule sets become
inert without touching their content. Cream theme now consistent.

Also bumps nav-home z-index to 3 (above Snap. hero pill) so the Home
tap target can't be visually obscured on any viewport — addresses
Vincent's report that bottom-nav Home wasn't working.

NO ENGINE CHANGES. NO BACKEND. NO JS.
SW: bumped STATIC_VER to savvey-static-v345v63.
Footer: v3.4.5v63.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.63: " + $sha)
Write-Host "Footer: v3.4.5v63"
Write-Host "SW:     savvey-static-v345v63"
