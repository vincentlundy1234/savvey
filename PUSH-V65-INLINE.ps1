# =============================================================================
# Savvey v3.4.5v65 INLINE: V.64 follow-up fixes.
# - Duplicate verdict checkmark (CSS ::before + .verdict-dot both rendering)
# - 'IDENTIFIED · HOME' result badge floating wrong place — hide it
# - AI info `i` icon leaking mid-screen — re-anchor to top-right
# - Savvey Says decorator not firing because observer attaches AFTER
#   screen-result.active is already set — call decorator on every renderResult
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v65 (V.64 follow-up fixes) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta v3.4.5v64', 'Beta v3.4.5v65')
$html = $html.Replace('v3.4.5v64</span>', 'v3.4.5v65</span>')

$css = @"
  /* V.65 — V.64 visible regression fixes */

  /* 1. Verdict pill: drop the inner .verdict-dot span. ::before checkmark
        from V.64 already provides the dot. Showing both = ✓✓. */
  .verdict-pill .verdict-dot,
  .v5-verdict-pill .verdict-dot {
    display: none !important;
  }

  /* 2. Hide the legacy 'IDENTIFIED · HOME' confidence badge on result.
        The verdict pill already conveys identity + the basis line covers it.
        v5 design has neither badge. */
  #result-badge,
  .v5-confidence-chip {
    display: none !important;
  }

  /* 3. Re-anchor the AI info `i` icon to top-right of screen-result.
        It was floating mid-screen because of layout changes from V.41
        watermark + V.55 verdict-block hide. Pin it absolute top-right. */
  #ai-info-btn {
    position: absolute !important;
    top: 16px !important;
    right: 16px !important;
    z-index: 4 !important;
  }
  #screen-result { position: relative !important; }

  /* 4. Trim the verdict watermark — it's bleeding outside containers
        when verdict-block is showing. Tighten to inside the block only. */
  .v5-verdict-watermark {
    overflow: hidden !important;
    max-width: 100% !important;
  }

"@

$pattern = '(\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\})'
if ($html -match $pattern) {
    $match = $matches[0]
    $html = $html.Replace($match, "`r`n" + $css + $match)
    Write-Host "  [OK] V.65 fix CSS injected" -ForegroundColor Green
}

# Robust Savvey Says decorator — replace the V.64 observer-based hook with
# a function-proxy hook that fires on every renderResult call. This catches
# the cache-hit case where screen-result becomes active too fast for the
# MutationObserver to react.
$jsFix = @"

<script>
/* V.65: Savvey Says decorator that ALWAYS fires on renderResult.
   Replaces V.64 observer (which missed when cached results render before
   the observer attaches). Proxies window.renderResult to call decorator
   AFTER the original. Also proxies show() so re-rendering on same payload
   works. */
(function v65SavveyDecorator() {
  function decorate() {
    try {
      var lr = window.lastResult || (typeof lastResult !== 'undefined' ? lastResult : null);
      if (!lr || !lr.savvey_says) return;
      var ss = lr.savvey_says;
      var rows = document.getElementById('savvey-says-rows');
      var head = document.querySelector('#savvey-says .v5-savvey-says-head, #savvey-says .savvey-says-head');
      if (!rows || !head) return;

      // Drop existing v64/v65 inserts before re-injecting
      var oldPrefix = document.querySelector('#savvey-says .v5-savvey-says-prefix');
      var oldLive = document.querySelector('#savvey-says .v5-savvey-live-row');
      if (oldPrefix) oldPrefix.remove();
      if (oldLive) oldLive.remove();

      if (!ss.live_amazon_price) return;

      // Prefix tag
      var p = document.createElement('div');
      p.className = 'v5-savvey-says-prefix';
      p.textContent = 'Amazon UK live price check';
      head.parentNode.insertBefore(p, head.nextSibling);

      // Combined Live Price card + Buy on Amazon CTA
      var row = document.createElement('div');
      row.className = 'v5-savvey-live-row';
      var card = document.createElement('div');
      card.className = 'v5-savvey-live-card';
      card.innerHTML = '<div class="icon">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.5 11a2 2 0 0 0 2 1.5h7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="9" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/></svg>' +
        '</div>' +
        '<div><div class="label">Live price</div><div class="value">' + ss.live_amazon_price + '</div></div>';
      row.appendChild(card);
      var verifiedLink = (lr.verified_amazon_price && lr.verified_amazon_price.link)
        || ('https://www.amazon.co.uk/s?k=' + encodeURIComponent(lr.canonical_search_string || '') + '&tag=savvey-21');
      var cta = document.createElement('a');
      cta.className = 'v5-savvey-buy-cta';
      cta.href = verifiedLink;
      cta.target = '_top';
      cta.rel = 'external noopener';
      cta.innerHTML = 'Buy on Amazon &rarr;';
      row.appendChild(cta);
      head.parentNode.insertBefore(row, rows);

      // Hide the redundant 'Live at Amazon UK' row in the rows block
      Array.from(rows.querySelectorAll('.savvey-row')).forEach(function(r) {
        var t = r.querySelector('.ttl');
        if (t && /live at amazon/i.test(t.textContent)) r.style.display = 'none';
      });
    } catch (e) { console.warn('[v65 decorator]', e); }
  }

  function install() {
    if (typeof window.renderResult === 'function' && !window.__v65Wrapped) {
      var orig = window.renderResult;
      window.renderResult = function() {
        var ret = orig.apply(this, arguments);
        try { setTimeout(decorate, 30); } catch (e) {}
        return ret;
      };
      window.__v65Wrapped = true;
    }
    // Also re-decorate when result screen becomes active again (back nav)
    var sr = document.getElementById('screen-result');
    if (sr) {
      var obs = new MutationObserver(function() {
        if (sr.classList.contains('active')) setTimeout(decorate, 30);
      });
      obs.observe(sr, { attributes: true, attributeFilter: ['class'] });
    }
    if (sr && sr.classList.contains('active')) setTimeout(decorate, 30);
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
    Write-Host "  [OK] V.65 robust decorator injected" -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v64", "savvey-static-v345v65")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v65" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v65 Wave V.65: V.64 follow-up — visible result-screen regressions

Live test of V.64 surfaced 4 regressions on result screen:

1. Verdict pill rendered TWO checkmarks (✓✓) because V.64's CSS
   ::before adds a circular checkmark dot but the existing
   .verdict-dot inner span was still present. Drop the .verdict-dot
   span via display:none; ::before is sole source of truth.

2. 'IDENTIFIED · HOME' confidence badge was floating in a layout
   gap below the verdict pill. v5 design doesn't have this badge.
   Hide #result-badge and .v5-confidence-chip.

3. AI info `i` icon was rendering mid-screen (not top-right) because
   of layout shifts from V.41 watermark + V.55 verdict-block hide.
   Re-pin position absolute top:16 right:16 z:4 on screen-result.

4. V.64 Savvey Says decorator (prefix tag + Live Price card + Buy on
   Amazon CTA) wasn't firing because cached results render before the
   MutationObserver attaches. Replace with renderResult function
   proxy — fires after every renderResult call. Re-runs on
   class-change for back-nav. De-dupes existing v64/v65 inserts.

NO ENGINE CHANGES. NO BACKEND CHANGES.
SW: savvey-static-v345v65.  Footer: v3.4.5v65.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.65: " + $sha + " (V.64 follow-up)")
Write-Host "Footer: v3.4.5v65"
Write-Host "SW:     savvey-static-v345v65"
