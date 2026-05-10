# =============================================================================
# Savvey v3.4.5v64 INLINE: comprehensive v5 design alignment.
# All screens, single atomic push. CSS + JS hooks. Engine untouched.
# Welcome / Home / Camera / Barcode / Loading / Confirm / Result + verdict pill.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v64 (full v5 alignment) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

$html = $html.Replace('Beta v3.4.5v63', 'Beta v3.4.5v64')
$html = $html.Replace('v3.4.5v63</span>', 'v3.4.5v64</span>')

$css = @"
  /* ═══════════════════════════════════════════════════════════════
     V.64 FULL v5 ALIGNMENT — every screen tuned to source spec
     ═══════════════════════════════════════════════════════════════ */

  /* ----- WELCOME (screens-input-v5.jsx WelcomeScreen) ----- */
  #screen-welcome {
    padding: 60px 28px 44px !important;
    overflow-y: auto;
  }
  .welcome-trust-strip {
    padding: 5px 11px !important;
    background: rgba(255,255,255,0.6) !important;
    border: 1px solid rgba(20,32,26,0.08) !important;
    backdrop-filter: blur(20px) !important;
    -webkit-backdrop-filter: blur(20px) !important;
    border-radius: 999px !important;
    font-size: 10.5px !important;
    font-weight: 700 !important;
    letter-spacing: 0.6px !important;
    text-transform: uppercase !important;
    margin-bottom: 14px !important;
    width: fit-content !important;
  }
  .welcome-wordmark {
    font-family: 'Inter', system-ui, sans-serif !important;
    font-weight: 800 !important;
    font-size: 56px !important;
    letter-spacing: -0.025em !important;
    line-height: 1 !important;
  }
  .welcome-tagline {
    margin-top: 4px !important;
    font-family: 'Nunito', system-ui, sans-serif !important;
    font-size: 22px !important;
    font-weight: 700 !important;
    font-style: italic !important;
  }
  #screen-welcome h1, .welcome-hero {
    font-family: 'Nunito', system-ui, sans-serif !important;
    font-size: 38px !important;
    font-weight: 800 !important;
    line-height: 1.05 !important;
    letter-spacing: -0.025em !important;
  }
  #welcome-start-btn, .welcome-primary {
    background: linear-gradient(180deg, var(--green-light, #5fb455) 0%, var(--green, #2a6b22) 60%, var(--green-deep, #143d10) 100%) !important;
    border-radius: 20px !important;
    padding: 22px 20px !important;
    font-size: 20px !important;
    font-weight: 800 !important;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.25) inset,
      0 -2px 0 rgba(0,0,0,0.15) inset,
      0 8px 22px rgba(42,107,34,0.32),
      0 2px 4px rgba(42,107,34,0.18) !important;
  }
  #welcome-skip-btn, .welcome-secondary {
    background: var(--amber-soft, #fbeed4) !important;
    color: var(--amber-deep, #a06a08) !important;
    border: 1px solid rgba(214,137,16,0.22) !important;
    border-radius: 20px !important;
    padding: 22px 20px !important;
    font-size: 20px !important;
    font-weight: 800 !important;
  }

  /* ----- HOME — strip clutter (counter, recent, trust copy, version) ----- */
  /* These exist for product reasons but the v5 source has none of them
     visible on home. Hide them on the home screen. They remain in DOM and
     are still functional via Reset link / settings if needed. */
  body:has(#screen-home.active) #counter,
  body:has(#screen-home.active) #recent-row,
  body:has(#screen-home.active) .v5-home-footer,
  body:has(#screen-home.active) .trust-line,
  body:has(#screen-home.active) .v5-home-footer .trust-line {
    display: none !important;
  }
  /* Doors: keep inputs hidden until door tapped (v5 focusType state) */
  body:has(#screen-home.active) .door-input-wrap {
    display: none !important;
  }
  body:has(#screen-home.active) .door-input-wrap.show {
    display: flex !important;
  }
  /* Door hover/active feedback per v5 source */
  .v5-door {
    background: rgba(255,255,255,0.7) !important;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(20,32,26,0.06) !important;
    border-radius: 18px !important;
    padding: 16px 18px !important;
    box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset !important;
    min-height: 76px !important;
    transition: transform 120ms ease, background 120ms ease;
  }
  .v5-door:active { transform: scale(0.992); }
  .v5-door .v5-door-icon {
    width: 42px !important;
    height: 42px !important;
    border-radius: 12px !important;
    background: var(--green-soft, #e8f3e6) !important;
    display: flex; align-items: center; justify-content: center;
    flex: 0 0 auto;
  }
  .v5-greeting {
    font-family: 'Nunito', system-ui, sans-serif !important;
    font-size: 30px !important;
    font-weight: 800 !important;
    letter-spacing: -0.025em !important;
    line-height: 1.1 !important;
    margin: 0 0 56px !important;
  }
  .v5-greeting-smile { color: var(--green, #2a6b22) !important; }

  /* ----- CAMERA + BARCODE — restore nav, add scan line ----- */
  /* V.61 hid the v5-bottom-nav on camera/barcode/loading. v5 source actually
     KEEPS the nav visible on camera/barcode. Reverse for camera + barcode. */
  body:has(#screen-camera.active) .v5-bottom-nav,
  body:has(#screen-barcode.active) .v5-bottom-nav {
    display: grid !important;
  }
  /* Loading still hides nav (v5 design choice for the centerpiece moment) */

  /* Animated orange scan line for barcode screen */
  @keyframes v64-barcode-scan {
    0%, 100% { transform: translateY(-32px); opacity: 0.7; }
    50% { transform: translateY(32px); opacity: 1; }
  }
  body:has(#screen-barcode.active) #barcode-reader::after,
  #screen-barcode .v5-barcode-scanline {
    content: '';
    position: absolute;
    left: 20%; right: 20%;
    top: 50%;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f5a623 30%, #f5a623 70%, transparent 100%);
    box-shadow: 0 0 12px rgba(245,166,35,0.6);
    animation: v64-barcode-scan 1.6s ease-in-out infinite;
    pointer-events: none;
    z-index: 5;
  }

  /* ----- LOADING — retailer pills around centre S logo (v5 spec) ----- */
  /* This needs DOM injection too — handled by JS hook below. CSS here. */
  .v64-load-stage {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 32px;
    padding: 40px 20px 120px;
  }
  .v64-load-orbit {
    position: relative;
    width: 280px; height: 280px;
    display: flex; align-items: center; justify-content: center;
  }
  .v64-load-logo {
    width: 110px; height: 110px;
    border-radius: 28px;
    background: linear-gradient(180deg, var(--green-light, #5fb455) 0%, var(--green, #2a6b22) 60%, var(--green-deep, #143d10) 100%);
    display: flex; align-items: center; justify-content: center;
    color: #fff;
    font-family: 'Inter', system-ui, sans-serif;
    font-weight: 800; font-size: 56px;
    letter-spacing: -0.04em;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.3) inset,
      0 -3px 0 rgba(0,0,0,0.18) inset,
      0 12px 28px rgba(42,107,34,0.34);
    z-index: 2;
  }
  .v64-load-pill {
    position: absolute;
    padding: 6px 12px;
    background: #fff;
    border-radius: 999px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: var(--ink, #14201a);
    box-shadow: 0 2px 8px rgba(20,32,26,0.08);
    display: inline-flex; align-items: center; gap: 6px;
    white-space: nowrap;
    animation: v64-pill-float 6s ease-in-out infinite;
  }
  .v64-load-pill.checked .v64-load-pill-dot {
    width: 12px; height: 12px;
    border-radius: 999px;
    background: var(--green, #2a6b22);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 9px; font-weight: 800;
  }
  .v64-load-pill.pending .v64-load-pill-dot {
    width: 8px; height: 8px;
    border-radius: 999px;
    background: var(--amber, #d68910);
  }
  @keyframes v64-pill-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
  }
  .v64-load-phases {
    display: flex; gap: 12px; align-items: center;
    margin-top: 8px;
  }
  .v64-load-phase {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    flex: 1; max-width: 88px;
  }
  .v64-load-phase-dot {
    width: 18px; height: 18px;
    border-radius: 999px;
    border: 2px solid var(--green, #2a6b22);
    background: #fff;
    display: flex; align-items: center; justify-content: center;
    color: var(--green, #2a6b22);
    font-size: 10px; font-weight: 800;
  }
  .v64-load-phase.done .v64-load-phase-dot {
    background: var(--green, #2a6b22); color: #fff;
  }
  .v64-load-phase.current .v64-load-phase-dot::after {
    content: ''; width: 8px; height: 8px; border-radius: 999px;
    background: var(--green, #2a6b22);
  }
  .v64-load-phase.pending .v64-load-phase-dot {
    border-color: rgba(20,32,26,0.18); background: #fff;
  }
  .v64-load-phase-label {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px; font-weight: 700;
    color: var(--ink-soft, #4a5550);
    text-align: center; line-height: 1.2;
  }
  .v64-load-phase.pending .v64-load-phase-label { color: var(--ink-mute, #7a857f); }
  .v64-load-footer {
    font-family: 'Nunito', system-ui, sans-serif;
    font-size: 14px; font-weight: 700; font-style: italic;
    color: var(--ink-soft, #4a5550);
    margin-top: 16px;
  }
  .v64-load-line {
    width: 60%; max-width: 280px;
    height: 2px; background: rgba(20,32,26,0.12);
    margin-top: -12px; margin-bottom: 8px;
    position: relative;
  }
  .v64-load-line::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 33%;
    background: var(--green, #2a6b22);
    border-radius: 2px;
    transition: width 800ms ease;
  }

  /* ----- CONFIRM — sub line + bg ----- */
  body:has(#screen-confirm.active) {
    background:
      radial-gradient(60% 40% at 14% 14%, rgba(42,107,34,0.10) 0%, rgba(42,107,34,0) 65%),
      linear-gradient(180deg, #faf7f0 0%, #f6f1e6 100%) !important;
  }

  /* ----- RESULT verdict pill — gradient stamp with circular icon (v5) ----- */
  .v5-verdict-pill, .verdict-pill.show {
    display: inline-flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 7px 12px 7px 9px !important;
    color: #fff !important;
    border-radius: 999px !important;
    font-family: 'Inter', system-ui, sans-serif !important;
    font-size: 13px !important;
    font-weight: 800 !important;
    letter-spacing: -0.005em !important;
    text-transform: none !important;
    border: none !important;
    background: linear-gradient(180deg, var(--green, #2a6b22) 0%, var(--green-deep, #143d10) 100%) !important;
    box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset, 0 6px 16px rgba(42,107,34,0.33) !important;
    margin-bottom: 6px !important;
  }
  .verdict-pill.fair, .verdict-pill.wait,
  body.verdict-fair .v5-verdict-pill, body.verdict-wait .v5-verdict-pill {
    background: linear-gradient(180deg, var(--amber, #d68910) 0%, var(--amber-deep, #a06a08) 100%) !important;
    box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset, 0 6px 16px rgba(214,137,16,0.33) !important;
  }
  .verdict-pill.check_elsewhere,
  body.verdict-check_elsewhere .v5-verdict-pill {
    background: linear-gradient(180deg, var(--red, #cc4444) 0%, var(--red-deep, #8a2a2a) 100%) !important;
    box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset, 0 6px 16px rgba(204,68,68,0.33) !important;
  }
  .verdict-pill .verdict-dot,
  .v5-verdict-pill::before {
    content: '';
    width: 18px; height: 18px;
    border-radius: 999px;
    background: rgba(255,255,255,0.22);
    display: inline-flex;
    align-items: center; justify-content: center;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 12 9 17 20 6'/></svg>");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 12px;
  }

  /* ----- SAVVEY SAYS block restructure (per Vincent screenshot) ----- */
  /* Add prefix tag, combined live-price + buy-on-amazon row, typical band */
  .v5-savvey-says-prefix, .savvey-says-prefix {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: rgba(42,107,34,0.06);
    border-radius: 999px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 10.5px; font-weight: 800;
    letter-spacing: 0.6px;
    color: var(--green, #2a6b22);
    text-transform: uppercase;
    width: fit-content;
    margin: 0 0 12px;
  }
  .v5-savvey-says-prefix::before {
    content: ''; width: 6px; height: 6px; border-radius: 999px;
    background: var(--green, #2a6b22);
  }
  .v5-savvey-live-row {
    display: flex; align-items: stretch; gap: 8px;
    margin-bottom: 12px;
  }
  .v5-savvey-live-card {
    flex: 1;
    background: var(--green-soft, #e8f3e6);
    border-radius: 14px;
    padding: 12px 14px;
    display: flex; align-items: center; gap: 10px;
  }
  .v5-savvey-live-card .icon {
    width: 28px; height: 28px;
    border-radius: 8px;
    background: rgba(255,255,255,0.7);
    display: flex; align-items: center; justify-content: center;
    color: var(--green, #2a6b22);
    flex: 0 0 auto;
  }
  .v5-savvey-live-card .label {
    font-size: 9.5px; font-weight: 800; letter-spacing: 0.5px;
    color: var(--green-deep, #143d10);
    text-transform: uppercase;
    line-height: 1.1;
  }
  .v5-savvey-live-card .value {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 18px; font-weight: 800;
    color: var(--ink, #14201a);
    line-height: 1.1;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .v5-savvey-buy-cta {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 12px 16px;
    background: linear-gradient(180deg, var(--green, #2a6b22) 0%, var(--green-deep, #143d10) 100%);
    color: #fff;
    border: none; border-radius: 14px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 14px; font-weight: 800;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(42,107,34,0.28);
    flex: 0 0 auto;
    text-decoration: none;
  }
  .v5-savvey-buy-cta:hover { transform: translateY(-1px); }

  /* Verified pill on retailer alts */
  .v5-cta-verified {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px;
    background: var(--green-soft, #e8f3e6);
    border-radius: 999px;
    font-size: 9px; font-weight: 800;
    letter-spacing: 0.5px;
    color: var(--green-deep, #143d10);
    text-transform: uppercase;
    margin-left: 8px;
  }
  .v5-cta-verified::before {
    content: ''; width: 10px; height: 10px;
    border-radius: 999px;
    background: var(--green, #2a6b22);
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 12 9 17 20 6'/></svg>");
    background-repeat: no-repeat; background-position: center; background-size: 7px;
  }

"@

# Inject before [hidden] rule
$pattern = '(\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\})'
if ($html -match $pattern) {
    $match = $matches[0]
    $html = $html.Replace($match, "`r`n" + $css + $match)
    Write-Host "  [OK] V.64 master CSS injected" -ForegroundColor Green
} else {
    Write-Host "  [WARN] anchor missing - aborting" -ForegroundColor Yellow
    exit 1
}

# JS hook: render v5 loading orbit when screen-loading becomes active.
# Replaces the existing orbit content via DOM mutation observer.
$jsHook = @"

<script>
/* V.64: v5 loading orbit replacement.
   Listens for #screen-loading.active and injects the retailer-pill v5 layout.
   Engine-safe: only mutates inside #screen-loading; doesn't touch the
   loading-state JS that auto-advances after callNormalize completes. */
(function v64LoadingOrbit() {
  var RETAILERS = [
    { name: 'Very',         angle: 200, dist: 110, status: 'pending' },
    { name: 'Amazon',       angle: 250, dist: 115, status: 'checked' },
    { name: 'Argos',        angle: 290, dist: 110, status: 'pending' },
    { name: 'ASDA',         angle: 175, dist: 122, status: 'checked' },
    { name: 'Currys',       angle: 320, dist: 118, status: 'pending' },
    { name: 'Boots',        angle: 155, dist: 115, status: 'checked' },
    { name: 'John Lewis',   angle: 360, dist: 122, status: 'pending' },
    { name: 'AO',           angle: 130, dist: 130, status: 'checked' },
    { name: 'Tesco',        angle: 105, dist: 130, status: 'checked' },
  ];
  function buildStage() {
    var stage = document.createElement('div');
    stage.className = 'v64-load-stage';
    var orbit = document.createElement('div');
    orbit.className = 'v64-load-orbit';
    var logo = document.createElement('div');
    logo.className = 'v64-load-logo';
    logo.textContent = 'S';
    orbit.appendChild(logo);
    RETAILERS.forEach(function(r, i) {
      var p = document.createElement('div');
      p.className = 'v64-load-pill ' + (r.status === 'checked' ? 'checked' : 'pending');
      var rad = (r.angle * Math.PI) / 180;
      var x = Math.cos(rad) * r.dist;
      var y = Math.sin(rad) * r.dist;
      p.style.left = 'calc(50% + ' + x + 'px)';
      p.style.top  = 'calc(50% + ' + y + 'px)';
      p.style.transform = 'translate(-50%,-50%)';
      p.style.animationDelay = (i * 200) + 'ms';
      var dot = document.createElement('span');
      dot.className = 'v64-load-pill-dot';
      if (r.status === 'checked') dot.textContent = '✓';
      var lab = document.createElement('span');
      lab.textContent = r.name;
      p.appendChild(dot); p.appendChild(lab);
      orbit.appendChild(p);
    });
    stage.appendChild(orbit);
    var phases = document.createElement('div');
    phases.className = 'v64-load-phases';
    var P = [
      { lbl: 'Identifying the goods', state: 'done' },
      { lbl: 'Checking UK prices',     state: 'current' },
      { lbl: 'Checking retailers',           state: 'pending' },
      { lbl: 'Drafting verdict',             state: 'pending' }
    ];
    P.forEach(function(ph) {
      var w = document.createElement('div');
      w.className = 'v64-load-phase ' + ph.state;
      var d = document.createElement('div');
      d.className = 'v64-load-phase-dot';
      if (ph.state === 'done') d.textContent = '✓';
      var l = document.createElement('div');
      l.className = 'v64-load-phase-label';
      l.innerHTML = ph.lbl.replace(/ /g,'<br>');
      w.appendChild(d); w.appendChild(l);
      phases.appendChild(w);
    });
    stage.appendChild(phases);
    var foot = document.createElement('div');
    foot.className = 'v64-load-footer';
    foot.textContent = 'Working for you, not the retailer.';
    stage.appendChild(foot);
    return stage;
  }
  function paint() {
    var ld = document.getElementById('screen-loading');
    if (!ld || !ld.classList.contains('active')) return;
    if (ld.querySelector('.v64-load-stage')) return; // already painted
    // Hide existing children visually but keep them in DOM (engine may rely on them)
    Array.from(ld.children).forEach(function(c) { c.style.display = 'none'; });
    ld.appendChild(buildStage());
    ld.style.position = 'relative';
  }
  function unpaint() {
    var stage = document.querySelector('#screen-loading .v64-load-stage');
    if (stage) stage.remove();
    var ld = document.getElementById('screen-loading');
    if (ld) Array.from(ld.children).forEach(function(c){ c.style.display = ''; });
  }
  var obs = new MutationObserver(function() {
    var ld = document.getElementById('screen-loading');
    if (!ld) return;
    if (ld.classList.contains('active')) paint(); else unpaint();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      var ld = document.getElementById('screen-loading');
      if (ld) obs.observe(ld, { attributes: true, attributeFilter: ['class'] });
      // Also observe initial state
      if (ld && ld.classList.contains('active')) paint();
    });
  } else {
    var ld = document.getElementById('screen-loading');
    if (ld) {
      obs.observe(ld, { attributes: true, attributeFilter: ['class'] });
      if (ld.classList.contains('active')) paint();
    }
  }
})();

/* V.64: Savvey Says block restructure. Adds prefix tag + combined Live Price
   row with embedded Buy on Amazon CTA. Reads existing live_amazon_price +
   verified_amazon_link from window.lastResult — no engine changes. */
(function v64SavveySaysRestructure() {
  function decorate() {
    var lr = window.lastResult;
    if (!lr || !lr.savvey_says) return;
    var ss = lr.savvey_says;
    var rows = document.getElementById('savvey-says-rows');
    var head = document.querySelector('#savvey-says .v5-savvey-says-head, #savvey-says .savvey-says-head');
    if (!rows || !head) return;

    // Prefix tag
    var existingPrefix = document.querySelector('#savvey-says .v5-savvey-says-prefix');
    if (existingPrefix) existingPrefix.remove();
    if (ss.live_amazon_price) {
      var p = document.createElement('div');
      p.className = 'v5-savvey-says-prefix';
      p.textContent = 'Amazon UK live price check';
      head.parentNode.insertBefore(p, head.nextSibling);

      // Combined live-price + buy CTA row
      var existingLive = document.querySelector('#savvey-says .v5-savvey-live-row');
      if (existingLive) existingLive.remove();
      var row = document.createElement('div');
      row.className = 'v5-savvey-live-row';
      var card = document.createElement('div');
      card.className = 'v5-savvey-live-card';
      card.innerHTML = '<div class="icon">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.5 11a2 2 0 0 0 2 1.5h7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="9" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/></svg>' +
        '</div>' +
        '<div><div class="label">Live price</div><div class="value">' + ss.live_amazon_price + '</div></div>';
      row.appendChild(card);
      var verifiedLink = (lr.verified_amazon_price && lr.verified_amazon_price.link) || ss.verified_amazon_link || ('https://www.amazon.co.uk/s?k=' + encodeURIComponent(lr.canonical_search_string || '') + '&tag=savvey-21');
      var cta = document.createElement('a');
      cta.className = 'v5-savvey-buy-cta';
      cta.href = verifiedLink;
      cta.target = '_top';
      cta.rel = 'external noopener';
      cta.innerHTML = 'Buy on Amazon &rarr;';
      row.appendChild(cta);
      head.parentNode.insertBefore(row, rows);
    }

    // Hide the old Live at Amazon UK row in rowsData since we hoisted it above
    Array.from(rows.querySelectorAll('.savvey-row')).forEach(function(r) {
      var ttl = r.querySelector('.ttl');
      if (ttl && /live at amazon/i.test(ttl.textContent)) r.style.display = 'none';
    });
  }
  // Hook into renderResult by observing screen-result becoming active
  var obs = new MutationObserver(function() {
    var sr = document.getElementById('screen-result');
    if (sr && sr.classList.contains('active')) {
      setTimeout(decorate, 50);
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      var sr = document.getElementById('screen-result');
      if (sr) obs.observe(sr, { attributes: true, attributeFilter: ['class'] });
    });
  } else {
    var sr = document.getElementById('screen-result');
    if (sr) obs.observe(sr, { attributes: true, attributeFilter: ['class'] });
  }
})();
</script>
"@

# Inject JS just before </body>
if ($html -match '</body>') {
    $html = $html.Replace('</body>', $jsHook + "`r`n</body>")
    Write-Host "  [OK] V.64 JS hooks injected" -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v63", "savvey-static-v345v64")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v64" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v64 Wave V.64: comprehensive v5 design alignment

Single atomic push covering every screen vs the v5 source spec:

WELCOME — trust pill, 56px wordmark, 22px italic tagline, 38px hero h1
with green 'a snap' span, 20px primary CTA with 22px padding + multi-
layer green-glow shadow, amber-soft skip CTA same shape.

HOME — strip the recent chips, counter, version tag, How Savvey works
trust copy, affiliate disclosure from the on-screen view (still in DOM,
just hidden via :has). Doors get rgba(255,255,255,0.7) glass + 76px
min-height + 42px green-soft icon square. Door inputs hidden until
door tapped (focusType pattern from v5 source). Greeting Nunito 800,
30px, smile var(--green).

CAMERA + BARCODE — restore bottom-nav visibility (V.61 hid it; v5
source actually keeps it visible on capture screens). Add animated
orange scan line on barcode screen via ::after pseudo-element.

LOADING — full v5 rebuild via JS DOM injection. Replace the orbit-of-
letters with the v5 layout: 9 retailer pills (Very/Amazon/Argos/ASDA/
Currys/Boots/John Lewis/AO/Tesco) floating around a centred green S
logo, some pills 'checked' (green tick) some 'pending' (amber dot),
phase timeline at base (Identifying / Checking UK prices / Checking
retailers / Drafting verdict), 'Working for you, not the retailer.'
italic footer. Mutation observer paints on screen-loading.active and
unpaints when class is removed. Engine state is untouched.

CONFIRM — green-tinted body bg via :has().

RESULT VERDICT PILL — gradient stamp (green / amber / red per state)
with circular checkmark icon, soft glow shadow per v5 spec. Replaces
the flat coloured box.

RESULT SAVVEY SAYS BLOCK — JS DOM injection adds:
  - 'AMAZON UK LIVE PRICE CHECK' uppercase prefix tag with green dot
  - Combined top row: Live Price card (cart icon + label + value) on
    left, big green 'Buy on Amazon ->' gradient CTA on right
  - Hides the old vertical 'Live at Amazon UK' row (now hoisted)
Reads existing window.lastResult.savvey_says + verified_amazon_price.
NO backend changes — uses what the API already returns.

VERIFIED PILL — small 'VERIFIED' pill style on retailer alt rows
when SerpAPI confirmed a PDP deep link.

NO ENGINE CHANGES. NO BACKEND CHANGES.
SW: savvey-static-v345v64.  Footer: v3.4.5v64.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.64: " + $sha + " (full v5 alignment)")
Write-Host "Footer: v3.4.5v64"
Write-Host "SW:     savvey-static-v345v64"
