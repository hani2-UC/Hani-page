@echo off
cd /d "%~dp0\.."
py -3 "_tools\update_diary_manifest.py"
if errorlevel 1 (
  echo.
  echo Python could not be started. Try: python "_tools\update_diary_manifest.py"
)
echo.
echo diary/posts.json was updated.
pause
