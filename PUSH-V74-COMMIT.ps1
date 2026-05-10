# =============================================================================
# Savvey v3.4.5v74: production polish — loading-screen mojibake + disambig fix
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v74 (production polish) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

git add api/normalize.js index.html sw.js; GitOk "add"

$msgFile = Join-Path $env:TEMP "savvey_v74_commit_msg.txt"
$msg = @'
v3.4.5v74 Wave V.74: production polish - loading mojibake + disambig fix

Vincent push back: app still has "useless moments" pre-launch. Fixed
the most visible ones.

LOADING SCREEN MOJIBAKE (the cheap-looking one)
The V.64 retailer-orbit JS had UTF-8 mojibake baked in:
- Checkmark "tick" was stored as the byte sequence 0xE2 0x9C 0x93
  interpreted as Windows-1252, rendering as garbled chars on screen.
  Found in 4 places: 2 CSS comments, retailer-pill checked-state dot,
  phase-node done-state dot.
- All 4 replaced with the correct unicode tick character.
- Phase labels also had non-breaking-space mojibake which the JS was
  using as a hack to insert line breaks; replaced with regular spaces
  and switched to plain textContent rendering (no innerHTML, no
  NBSP-to-br substitution dance).

LOADING SCREEN PILL CLIPPING
Retailer orbit pill distances were 110-130px from center, which
clipped "Very" off the left edge and "John Lewis" off the right
on narrow phones. Tightened to 84-94px and reflowed angles for
even spread. Now fits a 280px stage on a 375px viewport with
proper margins.

DISAMBIG ROUTING FOR BRAND-ONLY (the Bose problem)
When a user types just "Bose" or "Logitech mouse", Haiku returns
confidence=low with alternative_string=null but alternatives_array
populated with 2-3 specific products. The disambig gate only
checked alternative_string, so these queries fell through to the
V.58 empty state ("Not on Amazon UK / Couldn't verify a live
listing") which is the wrong UX - we DO have suggestions to show.

Gate now also triggers when alternatives_array.length >= 1.
"Bose" -> disambig screen showing Bose QC45, Bose 700, Soundlink Flex
instead of dead-end empty state.

NO ENGINE CHANGES.
SW: savvey-static-v345v74. Footer: v3.4.5v74.
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
Write-Host ("Wave V.74: " + $sha)
Write-Host "Footer: v3.4.5v74"
Write-Host "SW:     savvey-static-v345v74"
Write-Host ""
Write-Host "After Vercel deploys (~30s):" -ForegroundColor Cyan
Write-Host "  1. Loading screen retailer pills show clean tick marks" -ForegroundColor Cyan
Write-Host "     and Very plus John Lewis are fully visible." -ForegroundColor Cyan
Write-Host "  2. Phase labels readable in one line." -ForegroundColor Cyan
Write-Host "  3. Type Bose on home goes to Which one screen with QC45 etc" -ForegroundColor Cyan
Write-Host "     instead of Not on Amazon UK empty state." -ForegroundColor Cyan
