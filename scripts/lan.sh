#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3001}"
HOST_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$HOST_IP" ]]; then
  HOST_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

if [[ -z "$HOST_IP" ]]; then
  echo "无法获取局域网 IP，请手动查看本机网络设置。"
else
  echo "手机访问: http://${HOST_IP}:${PORT}"
fi

npm run dev -- -H 0.0.0.0 -p "$PORT"
