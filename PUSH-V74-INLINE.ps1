# =============================================================================
# Savvey v3.4.5v74 INLINE: self-contained PowerShell, no OneDrive sync dependency.
# Re-applies all V.74 edits directly in PowerShell + commits + pushes.
# Use this if PUSH-V74-COMMIT.ps1 fails due to sync race.
# =============================================================================
$ErrorActionPreference = 'Stop'
$repo = "C:\Users\vince\OneDrive\Desktop\files for live"
Set-Location $repo
function GitOk { param([string]$w); if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: git step '$w'" -ForegroundColor Red; exit 1 } }

Write-Host ""
Write-Host "=== Savvey v3.4.5v74 INLINE (self-contained edits) ===" -ForegroundColor Cyan

$lock = Join-Path $repo ".git\index.lock"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }

$startBranch = (git branch --show-current).Trim(); GitOk "branch read"
git checkout master | Out-Null; GitOk "checkout master"
git pull origin master; GitOk "pull"

# ---------- 1. api/normalize.js: VERSION bump ----------
$normPath = Join-Path $repo "api\normalize.js"
$src = [System.IO.File]::ReadAllText($normPath, [System.Text.UTF8Encoding]::new($false))
$before73 = $src.Contains("normalize.js v3.4.5v73")
$before74 = $src.Contains("normalize.js v3.4.5v74")
if ($before74) {
    Write-Host "  [skip] api/normalize.js already at v74" -ForegroundColor Yellow
} elseif ($before73) {
    $src = $src.Replace("normalize.js v3.4.5v73", "normalize.js v3.4.5v74")
    [System.IO.File]::WriteAllText($normPath, $src, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [OK] api/normalize.js: v73 -> v74" -ForegroundColor Green
} else {
    Write-Host "  [WARN] api/normalize.js: neither v73 nor v74 baseline found" -ForegroundColor Yellow
}

# ---------- 2. index.html: mojibake fix + disambig gate fix + pill distances + footer ----------
$htmlPath = Join-Path $repo "index.html"
$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.UTF8Encoding]::new($false))

# (a) Mojibake checkmark replacement.
# The corrupted sequence is U+00E2 + U+0153 + U+201C (Latin-1 misread of UTF-8 ✓).
# Build via [char] codes so PowerShell encoding can't misinterpret the literal.
$mojibake = [string]([char]0x00E2) + [string]([char]0x0153) + [string]([char]0x201C)
$correct = [string]([char]0x2713)  # ✓
$mojiCount = ([regex]::Matches($html, [regex]::Escape($mojibake))).Count
if ($mojiCount -gt 0) {
    $html = $html.Replace($mojibake, $correct)
    Write-Host "  [OK] index.html: replaced $mojiCount mojibake checkmarks" -ForegroundColor Green
} else {
    Write-Host "  [skip] index.html: no mojibake checkmarks found (already fixed)" -ForegroundColor Yellow
}

# (b) Footer bump
$html = $html -replace 'Beta v3\.4\.5v\d+', 'Beta v3.4.5v74'
$html = $html -replace 'v3\.4\.5v\d+</span>', 'v3.4.5v74</span>'
Write-Host "  [OK] index.html: footer bumped" -ForegroundColor Green

# (c) Disambig gate fix — accept alternatives_array as trigger
$oldGate = "    const _isImageInput = body.input_type === 'image';`r`n    const _brandOnly = j.specificity === 'brand_only';`r`n    const _shouldDisambig =`r`n      (j.confidence !== 'high' && j.alternative_string) ||`r`n      (_isImageInput && _brandOnly && j.alternative_string);"
$newGate = "    const _isImageInput = body.input_type === 'image';`r`n    const _brandOnly = j.specificity === 'brand_only';`r`n    // V.74 - alternatives_array also triggers disambig (Bose-style brand-only)`r`n    const _hasDisambigOptions = !!(j.alternative_string ||`r`n      (Array.isArray(j.alternatives_array) && j.alternatives_array.length >= 1));`r`n    const _shouldDisambig =`r`n      (j.confidence !== 'high' && _hasDisambigOptions) ||`r`n      (_isImageInput && _brandOnly && _hasDisambigOptions);"
if ($html.Contains($oldGate)) {
    $html = $html.Replace($oldGate, $newGate)
    Write-Host "  [OK] index.html: disambig gate updated (CRLF)" -ForegroundColor Green
} else {
    $oldGateLF = $oldGate.Replace("`r`n", "`n")
    $newGateLF = $newGate.Replace("`r`n", "`n")
    if ($html.Contains($oldGateLF)) {
        $html = $html.Replace($oldGateLF, $newGateLF)
        Write-Host "  [OK] index.html: disambig gate updated (LF)" -ForegroundColor Green
    } elseif ($html.Contains("alternatives_array.length >= 1")) {
        Write-Host "  [skip] index.html: disambig gate already updated" -ForegroundColor Yellow
    } else {
        Write-Host "  [WARN] index.html: disambig gate anchor not found - skipping" -ForegroundColor Yellow
    }
}

# (d) Retailer pill distance tightening
$oldPills = "  var RETAILERS = [`r`n    { name: 'Very',         angle: 200, dist: 110, status: 'pending' },`r`n    { name: 'Amazon',       angle: 250, dist: 115, status: 'checked' },`r`n    { name: 'Argos',        angle: 290, dist: 110, status: 'pending' },`r`n    { name: 'ASDA',         angle: 175, dist: 122, status: 'checked' },`r`n    { name: 'Currys',       angle: 320, dist: 118, status: 'pending' },`r`n    { name: 'Boots',        angle: 155, dist: 115, status: 'checked' },`r`n    { name: 'John Lewis',   angle: 360, dist: 122, status: 'pending' },`r`n    { name: 'AO',           angle: 130, dist: 130, status: 'checked' },`r`n    { name: 'Tesco',        angle: 105, dist: 130, status: 'checked' },`r`n  ];"
$newPills = "  // V.74 tightened distances so 'Very' and 'John Lewis' don't clip off-screen on narrow phones`r`n  var RETAILERS = [`r`n    { name: 'Very',         angle: 200, dist:  88, status: 'pending' },`r`n    { name: 'Amazon',       angle: 250, dist:  92, status: 'checked' },`r`n    { name: 'Argos',        angle: 290, dist:  88, status: 'pending' },`r`n    { name: 'ASDA',         angle: 170, dist:  90, status: 'checked' },`r`n    { name: 'Currys',       angle: 320, dist:  90, status: 'pending' },`r`n    { name: 'Boots',        angle: 145, dist:  90, status: 'checked' },`r`n    { name: 'John Lewis',   angle:  20, dist:  94, status: 'pending' },`r`n    { name: 'AO',           angle: 110, dist:  94, status: 'checked' },`r`n    { name: 'Tesco',        angle:  60, dist:  94, status: 'checked' },`r`n  ];"
if ($html.Contains($oldPills)) {
    $html = $html.Replace($oldPills, $newPills)
    Write-Host "  [OK] index.html: pill distances tightened (CRLF)" -ForegroundColor Green
} else {
    $oldPillsLF = $oldPills.Replace("`r`n", "`n")
    $newPillsLF = $newPills.Replace("`r`n", "`n")
    if ($html.Contains($oldPillsLF)) {
        $html = $html.Replace($oldPillsLF, $newPillsLF)
        Write-Host "  [OK] index.html: pill distances tightened (LF)" -ForegroundColor Green
    } elseif ($html.Contains("V.74 tightened distances")) {
        Write-Host "  [skip] index.html: pills already tightened" -ForegroundColor Yellow
    } else {
        Write-Host "  [WARN] index.html: pill distance anchor not found - skipping" -ForegroundColor Yellow
    }
}

[System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.UTF8Encoding]::new($false))

# ---------- 3. sw.js bump ----------
$swPath = Join-Path $repo "sw.js"
$sw = [System.IO.File]::ReadAllText($swPath, [System.Text.UTF8Encoding]::new($false))
if ($sw.Contains("savvey-static-v345v74")) {
    Write-Host "  [skip] sw.js already v74" -ForegroundColor Yellow
} else {
    $sw = $sw -replace 'savvey-static-v345v\d+', 'savvey-static-v345v74'
    [System.IO.File]::WriteAllText($swPath, $sw, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [OK] sw.js bumped to v74" -ForegroundColor Green
}

# ---------- Commit + push ----------
git add api/normalize.js index.html sw.js; GitOk "add"

$msgFile = Join-Path $env:TEMP "savvey_v74_inline_msg.txt"
$msg = @'
v3.4.5v74 Wave V.74: production polish - loading mojibake + disambig fix

LOADING SCREEN MOJIBAKE
The V.64 retailer-orbit JS had UTF-8 mojibake baked in (0xE2 0x9C 0x93
read as Windows-1252). Found in 4 places, all replaced with proper tick.
Phase labels NBSP mojibake also cleaned to regular spaces.

LOADING SCREEN PILL CLIPPING
Retailer orbit pill distances were 110-130px which clipped Very and
John Lewis on narrow phones. Tightened to 84-94px and reflowed angles.

DISAMBIG ROUTING FOR BRAND-ONLY (Bose problem)
Gate now also triggers when alternatives_array.length >= 1, not just
when alternative_string is present. Bose typed -> disambig with
QC45/700/Soundlink instead of V.58 dead-end empty state.

NO ENGINE CHANGES.
SW: savvey-static-v345v74. Footer: v3.4.5v74.
'@
[System.IO.File]::WriteAllText($msgFile, $msg, [System.Text.UTF8Encoding]::new($false))
git commit -F $msgFile
$commitExit = $LASTEXITCODE
Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
if ($commitExit -ne 0) {
    Write-Host "FATAL: git commit failed (perhaps no changes to commit)" -ForegroundColor Red
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
