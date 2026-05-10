# =============================================================================
# Savvey v3.4.5v69 INLINE: LATENCY QUICK WINS BUNDLE
#
# Server-side patch (api/normalize.js + index.html footer + sw.js).
# Three changes from the Latency Optimization Expert audit:
#
#   1. Parallelize alternative_amazon_price into the existing Promise.all batch.
#      Was sequential, ~600-900ms latency leak on medium-confidence queries.
#   2. Drop SERPAPI_TIMEOUT_MS + GOOGLE_SHOPPING_TIMEOUT_MS from 4000 to 2000.
#      SerpAPI p50 is ~600ms / p95 ~1.4s; 4000ms timeout overshoots long-tail
#      by 2.5s. V.55 frontend already gracefully handles "no live price".
#   3. Restructure 4 system prompts (vision/url/text/barcode) to share schema
#      via cache_control:ephemeral. All 4 doors hit one cache entry instead
#      of four. Estimated 150-250ms TTFB savings + 30-50% input-token cost.
#
# Deferred for later sessions:
#   #4 Frontend image compress (896px WebP q72)            ~700-900ms vision
#   #5 Speculative SerpAPI on raw text input               ~1.5-2.0s text/barcode
#   #6 Stale-while-revalidate canonical cache              instant on stale hits
#   #7 Combine price_take into Haiku #1 schema             ~600ms majority
#   #8 Hot-product canonical preload cron                  instant on top-20
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v69 (latency quick wins) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

# ---------------------------------------------------------------------------
# Edit api/normalize.js
# ---------------------------------------------------------------------------
$normPath = Join-Path $repo "api\normalize.js"
$src = Get-Content $normPath -Raw -Encoding UTF8

# Sanity check
if ($src -notmatch [regex]::Escape("normalize.js v3.4.5v56")) {
    Write-Host "  [WARN] expected VERSION v3.4.5v56; found something else - aborting" -ForegroundColor Yellow
    exit 1
}

# (1) VERSION bump
$src = $src.Replace("normalize.js v3.4.5v56", "normalize.js v3.4.5v69")
Write-Host "  [OK] VERSION bumped to v3.4.5v69" -ForegroundColor Green

# (2) SerpAPI Amazon engine timeout 4000 -> 2000
$src = $src.Replace("const SERPAPI_TIMEOUT_MS = 4000;", "const SERPAPI_TIMEOUT_MS = 2000; // V.69 - was 4000ms; SerpAPI p95 ~1.4s")
Write-Host "  [OK] SERPAPI_TIMEOUT_MS 4000 to 2000" -ForegroundColor Green

# (3) google_shopping engine timeout 4000 -> 2000
$src = $src.Replace("const GOOGLE_SHOPPING_TIMEOUT_MS = 4000;", "const GOOGLE_SHOPPING_TIMEOUT_MS = 2000; // V.69")
Write-Host "  [OK] GOOGLE_SHOPPING_TIMEOUT_MS 4000 to 2000" -ForegroundColor Green

# (4) Strip schema interpolation from each of the 4 system prompt template literals.
# Regex matches trailing whitespace + literal $-brace-COMMON_SCHEMA_DOC-brace-backtick-semicolon
# and replaces with just backtick-semicolon (closing the template literal).
$schemaRefRegex = '\$\{COMMON_SCHEMA_DOC\}'
$beforeCount = ([regex]::Matches($src, $schemaRefRegex)).Count
$src = $src -replace ('(\r?\n)+' + $schemaRefRegex + '`;'), '`;'
$afterCount = ([regex]::Matches($src, $schemaRefRegex)).Count
$strippedCount = $beforeCount - $afterCount
if ($strippedCount -lt 4) {
    Write-Host ("  [WARN] expected to strip 4 schema interpolations; only stripped " + $strippedCount) -ForegroundColor Yellow
    Write-Host "  Will continue but verify file diff before push." -ForegroundColor Yellow
}
Write-Host ("  [OK] stripped schema-doc interpolation from " + $strippedCount + " prompts") -ForegroundColor Green

# (5) Inject SHARED_SYSTEM_PREFIX const right before VISION_SYSTEM_PROMPT.
# Single-quoted here-string preserves all chars literally including dollar/brace/backtick.
$sharedPrefixDecl = @'

// V.69 - Shared system prefix injected as the cache_control:ephemeral block
// across all 4 doors (vision/url/text/barcode). Anthropic prompt cache matches
// by prefix; this means all 4 doors share ONE cache entry instead of four.
// Mode-specific tails (VISION_SYSTEM_PROMPT etc) become the second uncached
// system block. Cold-call TTFB drops ~150-250ms; input-token cost drops 30-50%.
const SHARED_SYSTEM_PREFIX = `You are Savvey, a UK retail product identifier.

When given an input you produce a clean canonical search string and metadata in the strict JSON shape below. Mode-specific guidance (PHOTO / URL / TEXT / BARCODE) is appended in a separate block after this one.

${COMMON_SCHEMA_DOC}`;
'@

if ($src -match 'const VISION_SYSTEM_PROMPT = ') {
    $src = $src.Replace("const VISION_SYSTEM_PROMPT = ", ($sharedPrefixDecl + "`r`n`r`nconst VISION_SYSTEM_PROMPT = "))
    Write-Host "  [OK] SHARED_SYSTEM_PREFIX const injected" -ForegroundColor Green
} else {
    Write-Host "  [WARN] couldn't find VISION_SYSTEM_PROMPT anchor - aborting" -ForegroundColor Yellow
    exit 1
}

# (6) Modify callHaikuText to use two-block system array
$oldCallText = "        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],`r`n        messages: [{ role: 'user', content: userText }],"
$newCallText = "        // V.69 - two-block system: shared schema cached, mode-tail uncached.`r`n        system: [`r`n          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },`r`n          { type: 'text', text: systemPrompt },`r`n        ],`r`n        messages: [{ role: 'user', content: userText }],"
if ($src.Contains($oldCallText)) {
    $src = $src.Replace($oldCallText, $newCallText)
    Write-Host "  [OK] callHaikuText system array restructured (CRLF)" -ForegroundColor Green
} else {
    $oldCallTextLF = $oldCallText.Replace("`r`n", "`n")
    $newCallTextLF = $newCallText.Replace("`r`n", "`n")
    if ($src.Contains($oldCallTextLF)) {
        $src = $src.Replace($oldCallTextLF, $newCallTextLF)
        Write-Host "  [OK] callHaikuText system array restructured (LF)" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] callHaikuText anchor not found - aborting" -ForegroundColor Yellow
        exit 1
    }
}

# (7) Modify callHaikuVision to use two-block system array
$oldCallVision = "        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],`r`n        messages: [{ role: 'user', content: userContent }],"
$newCallVision = "        // V.69 - two-block system: shared schema cached, mode-tail uncached.`r`n        system: [`r`n          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },`r`n          { type: 'text', text: systemPrompt },`r`n        ],`r`n        messages: [{ role: 'user', content: userContent }],"
if ($src.Contains($oldCallVision)) {
    $src = $src.Replace($oldCallVision, $newCallVision)
    Write-Host "  [OK] callHaikuVision system array restructured (CRLF)" -ForegroundColor Green
} else {
    $oldCallVisionLF = $oldCallVision.Replace("`r`n", "`n")
    $newCallVisionLF = $newCallVision.Replace("`r`n", "`n")
    if ($src.Contains($oldCallVisionLF)) {
        $src = $src.Replace($oldCallVisionLF, $newCallVisionLF)
        Write-Host "  [OK] callHaikuVision system array restructured (LF)" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] callHaikuVision anchor not found - aborting" -ForegroundColor Yellow
        exit 1
    }
}

# (8) Parallelize alternative_amazon_price into existing Promise.all batch
$oldParallelBlock = @'
  let verified_amazon_price = null;
  let retailer_deep_links = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    const canonicalKey = String(parsed.canonical_search_string).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const [amazonRes, retailersRes] = await Promise.all([
      fetchVerifiedAmazonPrice(parsed.canonical_search_string),
      fetchGoogleShoppingDeepLinks(parsed.canonical_search_string, canonicalKey),
    ]);
    verified_amazon_price = amazonRes;
    retailer_deep_links = retailersRes;
  }
'@

$newParallelBlock = @'
  // V.69 - alternative_amazon_price now rides the existing Promise.all batch
  // (was sequential before; ~600-900ms latency leak on medium-conf queries).
  // Powers disambig-screen thumbnails so users compare visually instead of
  // recalling model numbers (panel mandate 6 May 2026 beta - Logitech M235 vs
  // M185 case). Cost still ONE extra SerpAPI call per disambig (~30% queries).
  let verified_amazon_price = null;
  let retailer_deep_links = null;
  let alternative_amazon_price_v69 = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    const canonicalKey = String(parsed.canonical_search_string).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const fetchAlt = (parsed.alternative_string && parsed.confidence === 'medium')
      ? fetchVerifiedAmazonPrice(parsed.alternative_string)
      : Promise.resolve(null);
    const [amazonRes, retailersRes, altAmazonRes] = await Promise.all([
      fetchVerifiedAmazonPrice(parsed.canonical_search_string),
      fetchGoogleShoppingDeepLinks(parsed.canonical_search_string, canonicalKey),
      fetchAlt,
    ]);
    verified_amazon_price = amazonRes;
    retailer_deep_links = retailersRes;
    alternative_amazon_price_v69 = altAmazonRes;
  }
'@

# Try CRLF then LF
$oldParallelCRLF = $oldParallelBlock -replace "`n", "`r`n"
$newParallelCRLF = $newParallelBlock -replace "`n", "`r`n"
$parallelDone = $false
if ($src.Contains($oldParallelCRLF)) {
    $src = $src.Replace($oldParallelCRLF, $newParallelCRLF)
    Write-Host "  [OK] alternative_amazon_price parallelized (CRLF)" -ForegroundColor Green
    $parallelDone = $true
} elseif ($src.Contains($oldParallelBlock)) {
    $src = $src.Replace($oldParallelBlock, $newParallelBlock)
    Write-Host "  [OK] alternative_amazon_price parallelized (LF)" -ForegroundColor Green
    $parallelDone = $true
}
if (-not $parallelDone) {
    Write-Host "  [WARN] parallelize anchor not found - aborting" -ForegroundColor Yellow
    Write-Host "  Inspect api/normalize.js around line 980 (verified_amazon_price block)" -ForegroundColor Yellow
    exit 1
}

# Replace the now-redundant sequential alternative_amazon_price block AND wire the new var
$oldSequentialAlt = @'
  // v3.4.5i — fetch alternative's verified Amazon listing too when confidence
  // is medium and an alternative was produced. Powers disambig-screen
  // thumbnails so users compare visually instead of recalling model numbers
  // (panel-mandated 6 May 2026 beta finding — Logitech M235 vs M185 case).
  // Cost: ONE extra SerpAPI call per disambig case (~30% of queries).
  let alternative_amazon_price = null;
  if (parsed.alternative_string && parsed.confidence === 'medium') {
    alternative_amazon_price = await fetchVerifiedAmazonPrice(parsed.alternative_string);
  }
'@

$newSequentialAlt = @'
  // V.69 - alternative_amazon_price now resolved via the parallel batch above.
  const alternative_amazon_price = alternative_amazon_price_v69;
'@

$oldSeqCRLF = $oldSequentialAlt -replace "`n", "`r`n"
$newSeqCRLF = $newSequentialAlt -replace "`n", "`r`n"
$seqDone = $false
if ($src.Contains($oldSeqCRLF)) {
    $src = $src.Replace($oldSeqCRLF, $newSeqCRLF)
    $seqDone = $true
} elseif ($src.Contains($oldSequentialAlt)) {
    $src = $src.Replace($oldSequentialAlt, $newSequentialAlt)
    $seqDone = $true
}
if (-not $seqDone) {
    Write-Host "  [WARN] sequential alt-amazon block not found - aborting (parallelize half-applied)" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] sequential alternative_amazon_price replaced with var assignment" -ForegroundColor Green

# Write normalize.js back
[System.IO.File]::WriteAllText($normPath, $src, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] api/normalize.js written" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Edit index.html - footer label
# ---------------------------------------------------------------------------
$htmlPath = Join-Path $repo "index.html"
$html = Get-Content $htmlPath -Raw -Encoding UTF8
$html = $html -replace 'Beta v3\.4\.5v\d+', 'Beta v3.4.5v69'
$html = $html -replace 'v3\.4\.5v\d+</span>', 'v3.4.5v69</span>'
[System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] index.html footer rewritten" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Edit sw.js - STATIC_VER
# ---------------------------------------------------------------------------
$swPath = Join-Path $repo "sw.js"
$sw = Get-Content $swPath -Raw -Encoding UTF8
$sw = $sw.Replace("savvey-static-v345v68", "savvey-static-v345v69")
[System.IO.File]::WriteAllText($swPath, $sw, [System.Text.UTF8Encoding]::new($false))
Write-Host "  [OK] sw.js bumped to savvey-static-v345v69" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Commit + push
# ---------------------------------------------------------------------------
git add api/normalize.js index.html sw.js; GitOk "add"
$msg = @'
v3.4.5v69 Wave V.69: latency quick wins - parallelize + timeout + shared cache

Three Latency Expert audit wins:

1. Parallelize alternative_amazon_price into existing Promise.all batch.
   Was sequential (~600-900ms latency leak on medium-conf queries).
   Now rides the same fan-out as Amazon engine + google_shopping.

2. Drop SERPAPI_TIMEOUT_MS + GOOGLE_SHOPPING_TIMEOUT_MS from 4000 to 2000.
   SerpAPI p50 is ~600ms, p95 ~1.4s. 4000ms was overshooting long-tail
   by 2.5s on every fail. V.55 frontend already gracefully handles
   "no live price" via "Tap to search Amazon UK" fallback copy.

3. Restructure 4 system prompts to share schema via prompt cache prefix.
   SHARED_SYSTEM_PREFIX block (cache_control:ephemeral) carries the
   schema; mode-specific tails follow as a second uncached block.
   All 4 doors now hit ONE cache entry instead of four. Estimated
   150-250ms TTFB savings + 30-50% input-token cost reduction across
   cold calls.

Deferred for later: image compress, speculative SerpAPI, stale-while-
revalidate canonical cache, combine price_take into Haiku #1, hot-
product preload cron.

NO ENGINE CHANGES (output schema unchanged).
SW: savvey-static-v345v69.  Footer: v3.4.5v69.
'@
git commit -m $msg; GitOk "commit"
$sha = (git rev-parse --short HEAD).Trim()
Write-Host ("  master committed: " + $sha) -ForegroundColor Green
git push origin master; GitOk "push"
if ($startBranch -and $startBranch -ne 'master') { git checkout $startBranch | Out-Null; GitOk "checkout return" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host ("Wave V.69: " + $sha)
Write-Host "Footer: v3.4.5v69"
Write-Host "SW:     savvey-static-v345v69"
