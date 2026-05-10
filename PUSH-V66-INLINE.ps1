# =============================================================================
# Savvey v3.4.5v66 INLINE: drop V.64 verdict pill ::before pseudo (duplicate
# checkmark — the existing .v5-verdict-pill-icon span already shows the SVG
# tick). Hide the leftover .verdict-dot span (already hidden, just enforce).
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v66 (verdict pill duplicate fix) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta v3.4.5v65', 'Beta v3.4.5v66')
$html = $html.Replace('v3.4.5v65</span>', 'v3.4.5v66</span>')

$css = @"
  /* V.66 - kill the V.64 ::before checkmark on verdict pill. The existing
     .v5-verdict-pill-icon SVG span is the sole tick. ::before was producing
     a second visible checkmark. */
  .verdict-pill::before,
  .v5-verdict-pill::before { content: none !important; display: none !important; background: none !important; }
  .v5-verdict-pill-icon {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 18px !important; height: 18px !important;
    border-radius: 999px !important;
    background: rgba(255,255,255,0.22) !important;
    color: #fff !important;
    flex: 0 0 auto !important;
  }
  .v5-verdict-pill-icon svg { width: 12px; height: 12px; }

"@

$pattern = '(\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\})'
if ($html -match $pattern) {
    $match = $matches[0]
    $html = $html.Replace($match, "`r`n" + $css + $match)
    Write-Host "  [OK] V.66 CSS injected" -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v65", "savvey-static-v345v66")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v66" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v66 Wave V.66: verdict pill - kill duplicate checkmark

V.64 added a ::before pseudo with embedded SVG checkmark to .verdict-pill.
But the existing DOM has <span class="v5-verdict-pill-icon"> with its own
inline SVG tick. So pill rendered TWO checkmarks side by side.

V.66: drop the V.64 ::before via content:none. Style the existing
.v5-verdict-pill-icon span to match the v5 source spec (18x18 white-22%
circle background, white tick centered).

NO ENGINE CHANGES.
SW: savvey-static-v345v66.  Footer: v3.4.5v66.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.66: " + $sha)
Write-Host "Footer: v3.4.5v66"
Write-Host "SW:     savvey-static-v345v66"
