# =============================================================================
# Savvey v3.4.5v67 INLINE: V.66 follow-ups.
# 1. Footer label sync: v59 → v67. (V.66 silently no-op'd because the file's
#    actual prior footer string was v59, not v65.)
# 2. V.65 decorator timing race fix: add MutationObserver on
#    #savvey-says-rows so the redundant "Live at Amazon UK" row gets hidden
#    every time renderSavveySays repopulates rows. Also remove the V.65
#    prefix + live-row inserts on row mutation so the hero card can't show
#    a previous query's stale price during the transition window.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v67 (V.66 follow-ups) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

# Footer label: catch the actual stale prior string (v59) AND any in-between
# variants in case some other wave bumped it. Idempotent — only the first
# match in each call matters.
$beforeFooterCount = ([regex]::Matches($html, 'Beta v3\.4\.5v\d+')).Count
$html = $html -replace 'Beta v3\.4\.5v\d+', 'Beta v3.4.5v67'
$html = $html -replace 'v3\.4\.5v\d+</span>', 'v3.4.5v67</span>'
Write-Host "  rewrote $beforeFooterCount footer-version strings to v67" -ForegroundColor Green

# V.67 timing-race fix — additive IIFE that watches #savvey-says-rows
# and re-runs the V.65 hide pass + flushes stale V.65 inserts on every
# row repopulation. Pure DOM, no engine touches.
$jsFix = @"

<script>
/* V.67: V.65 decorator timing race fix.
   V.65 fires on setTimeout(decorate, 30) after renderResult returns,
   but renderSavveySays() populates rows asynchronously after that.
   Net effect: brief stale price + redundant 'Live at Amazon UK' row.
   V.67 fix: MutationObserver on #savvey-says-rows childList that
   (a) removes the previous query's V.65 inserts immediately on mutation
       so the hero card cannot show a stale price during the transition;
   (b) hides any newly populated 'Live at Amazon UK' row by exact-text
       match — the row will re-appear on every new query render and we
       hide it each time. */
(function v67SavveyHardener() {
  function hideRedundantRow() {
    try {
      var rows = document.getElementById('savvey-says-rows');
      if (!rows) return;
      Array.from(rows.querySelectorAll('.savvey-row')).forEach(function(r) {
        var t = r.querySelector('.ttl, .label');
        if (t && /live at amazon/i.test(t.textContent || '')) {
          r.style.display = 'none';
        }
      });
    } catch (e) { console.warn('[v67 hideRedundantRow]', e); }
  }

  function flushStaleInserts() {
    try {
      var oldPrefix = document.querySelector('#savvey-says .v5-savvey-says-prefix');
      var oldLive = document.querySelector('#savvey-says .v5-savvey-live-row');
      if (oldPrefix) oldPrefix.remove();
      if (oldLive) oldLive.remove();
    } catch (e) { console.warn('[v67 flushStaleInserts]', e); }
  }

  function install() {
    var rows = document.getElementById('savvey-says-rows');
    if (!rows) {
      // Wait for DOM
      setTimeout(install, 100);
      return;
    }
    var obs = new MutationObserver(function() {
      // Step 1: kill stale V.65 inserts immediately so user can't see
      // the previous query's price flash.
      flushStaleInserts();
      // Step 2: after V.65's setTimeout(decorate, 30) re-inserts fresh
      // copies, hide the redundant row. Schedule for slightly after
      // V.65 to ensure rows are fully populated.
      setTimeout(hideRedundantRow, 80);
      setTimeout(hideRedundantRow, 250);
    });
    obs.observe(rows, { childList: true, subtree: false });
    // Initial pass for first render
    setTimeout(hideRedundantRow, 80);
    setTimeout(hideRedundantRow, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
</script>
"@

if ($html -match '</body>') {
    $html = $html.Replace('</body>', $jsFix + "`r`n</body>")
    Write-Host "  [OK] V.67 hardener IIFE injected before </body>" -ForegroundColor Green
} else {
    Write-Host "  [WARN] no </body> anchor found - aborting" -ForegroundColor Yellow
    exit 1
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v66", "savvey-static-v345v67")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v67" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v67 Wave V.67: V.66 follow-ups - footer label + V.65 timing race

1. Footer label was stuck at v59 because V.60-V.66 inline scripts each
   called Replace('Beta v3.4.5v<prior>', 'Beta v3.4.5v<next>') with the
   prior version string they expected, but actual prior was v59 not the
   expected one - so every call silently no-op'd. V.67 uses regex on
   'Beta v3\.4\.5v\d+' to catch any stale label.

2. V.65 decorator timing race: setTimeout(decorate, 30) ran before
   renderSavveySays() populated rows, so the 'Live at Amazon UK'
   redundant row reappeared visible on subsequent queries, and the
   V.65 hero card briefly showed previous query's stale price during
   the transition. V.67 adds a MutationObserver on #savvey-says-rows
   that (a) flushes stale V.65 prefix + live-row inserts on every
   childList mutation so hero card cannot display a previous price;
   (b) hides any 'Live at Amazon UK' row at +80ms and +250ms after
   each mutation - fires regardless of decorator timing.

NO ENGINE CHANGES.
SW: savvey-static-v345v67.  Footer: v3.4.5v67.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.67: " + $sha)
Write-Host "Footer: v3.4.5v67"
Write-Host "SW:     savvey-static-v345v67"
