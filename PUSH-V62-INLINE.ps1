# =============================================================================
# Savvey v3.4.5v62 INLINE: design-fidelity pass against v5 source.
# Uses regex anchor on the [hidden] !important rule to avoid em-dash issues.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v62 INLINE (design fidelity pass) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

$html = Get-Content "index.html" -Raw -Encoding UTF8

# Footer version bump
$html = $html.Replace('Beta v3.4.5v61', 'Beta v3.4.5v62')
$html = $html.Replace('v3.4.5v61</span>', 'v3.4.5v62</span>')

$preamble = @"
  /* V.62 DESIGN FIDELITY — close gap to v5 source (cream-first + atmosphere) */

  /* 1. KILL prefers-color-scheme dark auto-flip. v5 design is cream-first. */
  :root, html, body { color-scheme: light !important; }
  @media (prefers-color-scheme: dark) {
    :root {
      --green: #2a6b22 !important; --green-dark: #1d4a18 !important; --green-deep: #143d10 !important; --green-light: #5fb455 !important;
      --green-soft: #e8f3e6 !important; --green-softer: #d6f1d2 !important;
      --amber: #d68910 !important; --amber-deep: #a06a08 !important; --amber-soft: #fbeed4 !important;
      --red: #cc4444 !important; --red-deep: #8a2a2a !important; --red-soft: #fde0e0 !important;
      --ink: #14201a !important; --ink-soft: #4a5550 !important; --ink-mute: #7a857f !important;
      --bg: #faf7f0 !important; --bg-cream: #f6f1e6 !important; --bg-warm: #faf7f0 !important;
      --bg-green-wash: #eef5ea !important; --bg-amber-wash: #fbf3e1 !important;
      --card: #ffffff !important; --border: rgba(20,32,26,0.08) !important;
    }
    body { background: var(--bg) !important; color: var(--ink) !important; }
  }

  /* 2. Body cream gradient — replaces flat fill with v5 warm radial blend */
  body {
    background:
      radial-gradient(60% 36% at 18% 14%, rgba(95,180,85,0.08) 0%, rgba(95,180,85,0) 65%),
      radial-gradient(50% 32% at 88% 82%, rgba(214,137,16,0.07) 0%, rgba(214,137,16,0) 65%),
      linear-gradient(180deg, #faf7f0 0%, #f6f1e6 60%, #f0e9d8 100%) !important;
    background-attachment: fixed !important;
  }

  /* 3. Mesh atmosphere keyframes + auto-attached blobs on key screens */
  @keyframes v62-blob-a {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33%      { transform: translate(8%, 6%) scale(1.12); }
    66%      { transform: translate(-6%, 10%) scale(0.94); }
  }
  @keyframes v62-blob-b {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33%      { transform: translate(-7%, -9%) scale(1.08); }
    66%      { transform: translate(6%, -4%) scale(0.96); }
  }
  #screen-home::before,
  #screen-result::before,
  #screen-confirm::before,
  #screen-loading::before {
    content: '';
    position: absolute; inset: 0;
    pointer-events: none;
    z-index: 0;
    background:
      radial-gradient(70% 50% at 12% 10%, rgba(42,107,34,0.10) 0%, rgba(42,107,34,0) 65%),
      radial-gradient(60% 50% at 92% 88%, rgba(214,137,16,0.08) 0%, rgba(214,137,16,0) 65%);
    animation: v62-blob-a 32s ease-in-out infinite alternate;
  }
  #screen-home > *,
  #screen-result > *,
  #screen-confirm > *,
  #screen-loading > * { position: relative; z-index: 1; }

  /* 4. Per-screen body tints via :has() */
  body:has(#screen-loading.active) {
    background:
      radial-gradient(60% 40% at 50% 30%, rgba(95,180,85,0.16) 0%, rgba(95,180,85,0) 70%),
      linear-gradient(180deg, #eef5ea 0%, #e3eedc 100%) !important;
  }
  body:has(#screen-error.active) {
    background:
      radial-gradient(50% 36% at 50% 24%, rgba(214,137,16,0.14) 0%, rgba(214,137,16,0) 70%),
      linear-gradient(180deg, #fbf3e1 0%, #f4e8c8 100%) !important;
  }
  body.verdict-good_buy:has(#screen-result.active) {
    background:
      radial-gradient(60% 40% at 14% 14%, rgba(42,107,34,0.14) 0%, rgba(42,107,34,0) 65%),
      linear-gradient(180deg, #eef5ea 0%, #e3eedc 100%) !important;
  }
  body.verdict-fair:has(#screen-result.active),
  body.verdict-wait:has(#screen-result.active) {
    background:
      radial-gradient(60% 40% at 14% 14%, rgba(214,137,16,0.16) 0%, rgba(214,137,16,0) 65%),
      linear-gradient(180deg, #fbf3e1 0%, #f4e8c8 100%) !important;
  }
  body.verdict-check_elsewhere:has(#screen-result.active) {
    background:
      radial-gradient(60% 40% at 14% 14%, rgba(204,68,68,0.16) 0%, rgba(204,68,68,0) 65%),
      linear-gradient(180deg, #fbeaea 0%, #f4d2d2 100%) !important;
  }

  /* 5. Doors as frosted glass over cream */
  .v5-door {
    background: rgba(255,255,255,0.72) !important;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-color: rgba(20,32,26,0.06) !important;
    box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 2px 6px rgba(20,32,26,0.04) !important;
  }

  /* 6. Bottom nav green-soft band per v5 */
  .v5-bottom-nav {
    background: #e8f3e6 !important;
    border-top: 1px solid rgba(42,107,34,0.10) !important;
    backdrop-filter: none !important;
  }

  /* 7. Greeting Nunito display weight */
  .v5-greeting {
    font-family: 'Nunito', system-ui, sans-serif !important;
    font-weight: 800 !important;
    letter-spacing: -0.025em !important;
  }

"@

# Use regex to find the [hidden] !important rule that V.47 added — robust to em-dash
$pattern = '(\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\})'
if ($html -match $pattern) {
    $match = $matches[0]
    $html = $html.Replace($match, "`r`n" + $preamble + $match)
    Write-Host "  [OK] V.62 design-fidelity CSS injected before [hidden] rule" -ForegroundColor Green
} else {
    Write-Host "  [WARN] [hidden] regex not matched - aborting" -ForegroundColor Yellow
    exit 1
}

[System.IO.File]::WriteAllText((Join-Path $repo "index.html"), $html, [System.Text.UTF8Encoding]::new($false))

$sw = Get-Content "sw.js" -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v61", "savvey-static-v345v62")
[System.IO.File]::WriteAllText((Join-Path $repo "sw.js"), $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v62" -ForegroundColor Green

git add index.html sw.js; GitOk "add"
$msg = @"
v3.4.5v62 Wave V.62: design fidelity pass - close gap to v5 source

Forces light theme regardless of OS preference (v5 source is cream-first;
dark was opt-in only). Adds animated mesh-caustics atmosphere on home,
result, confirm, loading. Adds per-screen body tints via :has() for
green-wash loading, amber-wash error, green/amber/red verdict states.
Doors get frosted-glass treatment, bottom nav switches to green-soft band.

CSS-only. No engine, JS, or backend changes.

SW: bumped STATIC_VER to savvey-static-v345v62.
Footer: v3.4.5v62.
"@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host "  master committed: $sha" -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.62: " + $sha + " (design fidelity)")
Write-Host "Footer: v3.4.5v62"
Write-Host "SW:     savvey-static-v345v62"
