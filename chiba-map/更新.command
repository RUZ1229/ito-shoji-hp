#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP="$ROOT/更新.zip"
if [ ! -f "$ZIP" ]; then
  echo "更新.zip がありません。社長から受け取った 更新.zip をこのフォルダに置いてください。"
  read -p "Enter で終了..."
  exit 1
fi
echo "更新.zip を適用中..."
TMP=$(mktemp -d)
unzip -q -o "$ZIP" -d "$TMP"
SRC="$TMP"
for d in "$TMP"/*; do
  if [ -d "$d" ] && [ -f "$d/index.html" ]; then SRC="$d"; break; fi
done
rsync -a "$SRC/" "$ROOT/"
mv "$ZIP" "$ROOT/更新.zip.bak.$(date +%Y%m%d_%H%M%S)"
echo "更新完了。開く を再実行するか、ブラウザを再読込してください。"
read -p "Enter で終了..."
