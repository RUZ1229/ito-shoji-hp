@echo off
cd /d "%~dp0"
echo.
echo 千葉配送地図（手動モード）
echo 黒い画面は閉じないでください。閉じると地図が止まります。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve_windows.ps1" -Port 8766 -Root "%~dp0" -OpenBrowser
pause
