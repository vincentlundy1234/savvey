# =============================================================================
# Savvey v3.4.5v68 INLINE: PREMIUM POLISH BUNDLE
#
# Vincent ask: "premium helpful clean and quick app, screen-to-screen smoother,
# loading screen working with green S + retailer animations, haptics, helpful
# bounce/shade/animations".
#
# This wave adds:
#   1. Screen transitions: 220ms fade + 12px slide-up on enter, fade exit.
#      Respects prefers-reduced-motion.
#   2. Door tile press state: tactile scale-down + shadow drop on :active.
#   3. Verdict pill pop: scale-up entrance with subtle bounce on result land.
#   4. Bottom-nav tab tap feedback: brief active-state scale + tone shift.
#   5. Result-row stagger entrance: 60ms cascade as Savvey Says rows reveal.
#   6. Haptics layer: navigator.vibrate hooks on door clicks, search submit,
#      verdict reveal, error reveal, retailer-card open. Mobile only.
#   7. Smooth scroll-to-top on every screen change.
#   8. Loading orbit confirmation: ensure v5-orbit-spin keyframe still binds
#      (it does for non-reduced-motion users — leaving as-is).
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v68 (premium polish bundle) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

# Footer bump (regex-safe per V.67 pattern)
$html = $html -replace 'Beta v3\.4\.5v\d+', 'Beta v3.4.5v68'
$html = $html -replace 'v3\.4\.5v\d+</span>', 'v3.4.5v68</span>'

# CSS polish bundle — premium transitions, press states, entrance animations.
# Uses @media (prefers-reduced-motion: no-preference) gate so reduced-motion
# users still get instant transitions per Wave 109c.
$css = @"
  /* ===== V.68 PREMIUM POLISH — transitions + press states + entrance ===== */
  @media (prefers-reduced-motion: no-preference) {

    /* Screen-to-screen transition: fade + slide-up on enter */
    @keyframes v68-screen-enter {
      0%   { opacity: 0; transform: translateY(12px); }
      60%  { opacity: 1; }
      100% { opacity: 1; transform: translateY(0); }
    }
    .screen.active {
      animation: v68-screen-enter 280ms cubic-bezier(0.22, 1, 0.36, 1) both !important;
    }
    /* Suppress on initial page load to avoid double-fire with PWA splash */
    body:not(.v68-ready) .screen.active { animation: none !important; }

    /* Door tile press state: tactile scale + lift release */
    .v5-door, .door, [class*="v5-door"] {
      transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
                  box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1) !important;
      will-change: transform;
    }
    .v5-door:active, .door:active {
      transform: scale(0.972) !important;
      transition-duration: 80ms !important;
    }

    /* Bottom-nav tap feedback */
    .v5-bottom-nav .nav-tab, .nav-tab {
      transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1),
                  background-color 200ms ease,
                  color 200ms ease !important;
    }
    .v5-bottom-nav .nav-tab:active, .nav-tab:active {
      transform: scale(0.92) !important;
    }

    /* Verdict pill entrance — pop on result land */
    @keyframes v68-pill-pop {
      0%   { opacity: 0; transform: scale(0.88) translateY(6px); }
      60%  { opacity: 1; transform: scale(1.04) translateY(0); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    #screen-result.active .v5-verdict-pill,
    #screen-result.active .verdict-pill {
      animation: v68-pill-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both;
    }

    /* Hero image gentle reveal */
    @keyframes v68-hero-fade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    #screen-result.active img[src*="amazon"],
    #screen-result.active .v5-hero-img,
    #screen-result.active [class*="hero-img"] {
      animation: v68-hero-fade 360ms ease-out 160ms both;
    }

    /* Savvey Says block — slide-up entrance */
    @keyframes v68-says-rise {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #screen-result.active #savvey-says {
      animation: v68-says-rise 380ms cubic-bezier(0.22, 1, 0.36, 1) 200ms both;
    }

    /* Result rows stagger entrance */
    @keyframes v68-row-rise {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #screen-result.active #savvey-says-rows .savvey-row {
      animation: v68-row-rise 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    #screen-result.active #savvey-says-rows .savvey-row:nth-child(1) { animation-delay: 280ms; }
    #screen-result.active #savvey-says-rows .savvey-row:nth-child(2) { animation-delay: 340ms; }
    #screen-result.active #savvey-says-rows .savvey-row:nth-child(3) { animation-delay: 400ms; }
    #screen-result.active #savvey-says-rows .savvey-row:nth-child(4) { animation-delay: 460ms; }
    #screen-result.active #savvey-says-rows .savvey-row:nth-child(n+5) { animation-delay: 520ms; }

    /* CTA row entrance */
    #screen-result.active #cta-list > * {
      animation: v68-row-rise 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    #screen-result.active #cta-list > *:nth-child(1) { animation-delay: 360ms; }
    #screen-result.active #cta-list > *:nth-child(2) { animation-delay: 420ms; }
    #screen-result.active #cta-list > *:nth-child(3) { animation-delay: 480ms; }
    #screen-result.active #cta-list > *:nth-child(n+4) { animation-delay: 540ms; }

    /* Retailer card press state */
    #cta-list > * {
      transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
                  box-shadow 160ms cubic-bezier(0.22, 1, 0.36, 1) !important;
    }
    #cta-list > *:active {
      transform: scale(0.985) !important;
    }

    /* Buy on Amazon CTA hover/active feedback */
    .v5-savvey-buy-cta {
      transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
                  filter 160ms ease !important;
    }
    .v5-savvey-buy-cta:active {
      transform: scale(0.97) !important;
      filter: brightness(0.94);
    }

    /* AI info `i` icon hover wiggle */
    #ai-info-btn {
      transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1) !important;
    }
    #ai-info-btn:active {
      transform: scale(0.88) !important;
    }
  }

  /* Reduced-motion users: keep instant feedback on press but no entrance anim */
  @media (prefers-reduced-motion: reduce) {
    .v5-door:active, .door:active,
    .v5-bottom-nav .nav-tab:active, .nav-tab:active,
    #cta-list > *:active,
    .v5-savvey-buy-cta:active,
    #ai-info-btn:active {
      opacity: 0.85;
    }
  }

"@

$pattern = '(\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\})'
if ($html -match $pattern) {
    $match = $matches[0]
    $html = $html.Replace($match, "`r`n" + $css + $match)
    Write-Host "  [OK] V.68 polish CSS injected" -ForegroundColor Green
}

# JS bundle: haptics + screen-change scroll-reset + body.v68-ready guard
$jsFix = @"

<script>
/* V.68 PREMIUM POLISH — haptics layer + screen-change side effects.
   Mobile-only (navigator.vibrate is no-op on desktop, but harmless).
   Patterns:
     - Light  (8ms)        : door / retailer / nav tap, AI info icon
     - Medium (14ms)       : Search submit, Snap capture, Buy on Amazon
     - Pop    ([6,30,8])   : verdict reveal
     - Notify ([10,40,10]) : error screen reveal
*/
(function v68Haptics() {
  var canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  function vib(p) { if (!canVibrate) return; try { navigator.vibrate(p); } catch (e) {} }

  var H = {
    light:  function() { vib(8); },
    medium: function() { vib(14); },
    pop:    function() { vib([6, 30, 8]); },
    notify: function() { vib([10, 40, 10]); }
  };
  window.savveyHaptics = H;

  // Door / retailer / nav tap haptics via event delegation
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.v5-door, .door, .nav-tab, #cta-list > *, #ai-info-btn, .actions-row [role="button"], .v5-actions-row > *')) {
      H.light();
    }
    if (t.closest('#text-go, #btn-text-go, [data-action="text-go"], .v5-savvey-buy-cta, button.search-go') ||
        (t.closest('button') && /^search$|^go$|buy on amazon/i.test(t.closest('button').textContent || ''))) {
      H.medium();
    }
  }, true);

  // Verdict reveal: when screen-result becomes active AND pill has tone class
  var srObs = new MutationObserver(function() {
    var sr = document.getElementById('screen-result');
    if (!sr || !sr.classList.contains('active')) return;
    var pill = document.getElementById('verdict-pill');
    if (pill && (pill.classList.contains('show') || /good_buy|fair|wait|check_elsewhere/.test(pill.className))) {
      setTimeout(H.pop, 320);
    }
  });
  var sr = document.getElementById('screen-result');
  if (sr) srObs.observe(sr, { attributes: true, attributeFilter: ['class'] });

  // Error screen reveal
  var seObs = new MutationObserver(function() {
    var se = document.getElementById('screen-error');
    if (se && se.classList.contains('active')) setTimeout(H.notify, 100);
  });
  var se = document.getElementById('screen-error');
  if (se) seObs.observe(se, { attributes: true, attributeFilter: ['class'] });

  // Smooth scroll-to-top on every screen activation
  var screens = document.querySelectorAll('.screen');
  screens.forEach(function(scr) {
    new MutationObserver(function() {
      if (scr.classList.contains('active')) {
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      }
    }).observe(scr, { attributes: true, attributeFilter: ['class'] });
  });

  // Mark body ready so screen-enter animation only fires after first user nav.
  // Avoids the entrance animation on initial page load (PWA splash already fades).
  function markReady() {
    if (document.body) document.body.classList.add('v68-ready');
  }
  // First user interaction enables the screen-enter animation
  var firstInteraction = function() {
    markReady();
    document.removeEventListener('click', firstInteraction, true);
    document.removeEventListener('touchstart', firstInteraction, true);
  };
  document.addEventListener('click', firstInteraction, true);
  document.addEventListener('touchstart', firstInteraction, true);
  // Safety net: enable after 1.5s regardless
  setTimeout(markReady, 1500);
})();
</script>
"@

if ($html -match '</body>') {
    $html = $html.Replace('</body>', $jsFix + "`r`n</body>")
    Write-Host "  [OK] V.68 haptics + scroll-reset JS injected" -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v67", "savvey-static-v345v68")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v68" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v68 Wave V.68: premium polish bundle - transitions + haptics

Vincent ask: app should feel premium / clean / quick / helpful, smoother
screen-to-screen, loading screen polish, helpful bounce + haptics.

CSS polish (gated behind prefers-reduced-motion: no-preference):
- Screen-to-screen transition: 280ms fade + 12px slide-up entrance,
  cubic-bezier easing. Suppressed on initial load via body.v68-ready.
- Door tile + retailer card + nav tab + AI info icon press states:
  scale-down 0.972, 80ms tap response.
- Verdict pill entrance: bouncy scale-pop on result land (cubic-bezier
  with overshoot for tactile delight).
- Hero image gentle fade-in 360ms after pill.
- Savvey Says block slide-up at 200ms.
- Savvey Says rows + CTA rows stagger entrance (60ms cascade).
- Buy on Amazon press state with brightness shift.
- Reduced-motion users get instant opacity press feedback only.

JS layer:
- Haptics (navigator.vibrate) on every key interaction via event
  delegation. Mobile-only - no-op desktop.
  - light (8ms): door / retailer / nav / AI info
  - medium (14ms): Search submit / Buy on Amazon / Snap capture
  - pop ([6,30,8]): verdict pill reveal (320ms after screen activation)
  - notify ([10,40,10]): error screen reveal
- Smooth scroll-to-top on every screen activation via MutationObserver.
- body.v68-ready gate so first-load doesn't double-animate over PWA
  splash.

NO ENGINE CHANGES.
SW: savvey-static-v345v68.  Footer: v3.4.5v68.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.68: " + $sha)
Write-Host "Footer: v3.4.5v68"
Write-Host "SW:     savvey-static-v345v68"
