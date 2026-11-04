@echo off
cd /d "%~dp0"
if not exist "更新.zip" (
  echo 更新.zip がありません。社長から受け取った 更新.zip をこのフォルダに置いてください。
  pause
  exit /b 1
)
echo 更新.zip を適用中...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$z=Join-Path $PWD '更新.zip'; $t=Join-Path $env:TEMP ('mapupd_'+[guid]::NewGuid()); Expand-Archive -Path $z -DestinationPath $t -Force; $src=Get-ChildItem $t -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'index.html') } | Select-Object -First 1; if (-not $src) { $src=Get-Item $t }; Copy-Item -Path (Join-Path $src.FullName '*') -Destination $PWD -Recurse -Force; Move-Item $z ($z+'.bak.'+(Get-Date -Format 'yyyyMMdd_HHmmss'))"
echo 更新完了。開く を再実行してください。
pause
