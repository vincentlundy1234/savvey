$ErrorActionPreference = 'Stop'
Set-Location "C:\Users\vince\OneDrive\Desktop\files for live"
git checkout master
git pull origin master
git add index.html sw.js
git commit -m "v3.4.5v77 Wave V.77: loading screen full rebuild - kill V.64 broken retailer orbit, polish v5 gradient badge + clean 4-phase timeline + single-source phase narration. SW v345v77."
git push origin master
$sha = (git rev-parse --short HEAD).Trim()
Write-Host ""
Write-Host "=== V.77 SHIPPED: $sha ===" -ForegroundColor Green
Write-Host "Footer: v3.4.5v77"
Write-Host "SW:     savvey-static-v345v77"
