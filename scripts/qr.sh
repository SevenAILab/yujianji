#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://yujianji.vercel.app}"

if ! command -v npx >/dev/null 2>&1; then
  echo "需要 Node.js/npm 才能生成二维码。" >&2
  exit 1
fi

echo "遇见集二维码：${URL}"
node -e 'require("qrcode-terminal").generate(process.argv[1], { small: true })' "$URL"
