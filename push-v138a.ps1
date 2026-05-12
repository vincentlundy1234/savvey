# push-v138a.ps1 — one-click push for V.138a
# Run from PowerShell:  .\push-v138a.ps1
# Or double-click in Explorer (right-click → Run with PowerShell)
#
# Clears the OneDrive index.lock ghost, scopes the commit to just the
# files this session changed, and pushes to origin/master.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\vince\OneDrive\Desktop\files for live'
Set-Location $repo

Write-Host "=== clear stale index.lock (if any) ===" -ForegroundColor Cyan
Remove-Item .git\index.lock -Force -ErrorAction SilentlyContinue
Write-Host "ok"

Write-Host "`n=== git status (changed files) ===" -ForegroundColor Cyan
git status --short

Write-Host "`n=== staging V.138 + V.138a files ===" -ForegroundColor Cyan
git add api/normalize.js index.html sw.js .commit-msg.txt

Write-Host "`n=== commit ===" -ForegroundColor Cyan
git commit -F .commit-msg.txt

Write-Host "`n=== push origin master ===" -ForegroundColor Cyan
git push origin master

Write-Host "`n=== done — Vercel auto-deploy starts now (~30s) ===" -ForegroundColor Green
Write-Host "Watch: https://vercel.com/vincentlundy1234s-projects/savvey/deployments"
Read-Host "`nPress Enter to close"
