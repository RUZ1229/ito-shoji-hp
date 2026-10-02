#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
PORT=8080
URL="http://127.0.0.1:${PORT}/index.html"
if lsof -i :${PORT} >/dev/null 2>&1; then
  if ! curl -s --max-time 2 "$URL" | head -1 | grep -q "<!DOCTYPE html>"; then
    lsof -ti :${PORT} | xargs kill 2>/dev/null || true
    sleep 1
  fi
fi
if ! lsof -i :${PORT} >/dev/null 2>&1; then
  python3 -m http.server ${PORT} >/dev/null 2>&1 &
  sleep 1
fi
open "$URL"
