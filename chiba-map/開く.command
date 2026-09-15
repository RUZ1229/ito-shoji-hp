#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
CFG="$ROOT/data/update_config.json"
if [ -f "$CFG" ]; then
  LIVE=$(python3 -c "import json; print(json.load(open('$CFG', encoding='utf-8')).get('live_url',''))" 2>/dev/null || true)
  if [ -n "$LIVE" ]; then
    open "$LIVE"
    exit 0
  fi
fi
cd "$ROOT" || exit 1
PORT=8766
URL="http://127.0.0.1:${PORT}/"
if lsof -i :${PORT} >/dev/null 2>&1; then
  if ! curl -s --max-time 2 "$URL" | head -1 | grep -q "<!DOCTYPE html>"; then
    lsof -ti :${PORT} | xargs kill 2>/dev/null || true
    sleep 1
  fi
fi
if ! lsof -i :${PORT} >/dev/null 2>&1; then
  python3 -m http.server ${PORT} >/dev/null 2>&1 &
fi
for i in $(seq 1 24); do
  if curl -s --max-time 2 "$URL" | head -1 | grep -q "<!DOCTYPE html>"; then
    open "$URL"
    exit 0
  fi
  sleep 0.5
done
echo "サーバー起動を待てませんでした。手動で開く.bat をお試しください。" >&2
exit 1
