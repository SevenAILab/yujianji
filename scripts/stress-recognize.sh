#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://localhost:3000}"
N="${2:-8}"
REQ="$(mktemp)"
trap 'rm -f "$REQ"' EXIT
python3 - "$REQ" <<'PY'
import base64, json, sys
b = base64.b64encode(open("public/seed/pink-leaf-real.jpg", "rb").read()).decode()
json.dump({"image": "data:image/jpeg;base64," + b,
           "userNote": "走了半天路，突然看到地上这一片，我蹲下来捡了一枚",
           "history": []}, open(sys.argv[1], "w"))
PY
ok=0
for i in $(seq 1 "$N"); do
  code_time=$(curl -s -o /dev/null --max-time 90 -X POST "$BASE/api/recognize" \
    -H 'content-type: application/json' --data-binary @"$REQ" \
    -w "%{http_code} %{time_total}")
  echo "第 $i 次: $code_time"
  [ "${code_time%% *}" = "200" ] && ok=$((ok + 1))
done
echo "成功 $ok / $N"
[ "$ok" -eq "$N" ]
