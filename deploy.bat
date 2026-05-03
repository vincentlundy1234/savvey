@echo off
REM Savvey deploy script
REM Usage: deploy "your commit message"
REM   or:  deploy            (uses default "deploy" message)
REM
REM Why this exists: OneDrive holds .git/index.lock so cowork's sandbox
REM can't fully chain add/commit/push. This wraps the whole sequence in
REM one command. Run from a terminal in this folder.

setlocal

cd /d "%~dp0"

if exist ".git\index.lock" (
    echo Removing stale .git\index.lock...
    del ".git\index.lock"
)
if exist ".git\HEAD.lock" (
    echo Removing stale .git\HEAD.lock...
    del ".git\HEAD.lock"
)

set "MSG=%~1"
if "%MSG%"=="" set "MSG=deploy"

echo.
echo === Staging tracked changes ===
git add -u
git status --short

echo.
echo === Committing ===
git commit -m "%MSG%"
if errorlevel 1 (
    echo.
    echo Commit had nothing to commit, or failed. Pushing anyway in case prior commits are unpushed...
)

echo.
echo === Pushing to origin/master ===
git push origin master

echo.
echo Done.
endlocal
