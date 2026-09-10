#!/usr/bin/env bash
# 部署后自检。用法：
#   bash scripts/verify-deploy.sh https://yujianji.mcs-eco.com
#   bash scripts/verify-deploy.sh https://yujianji.mcs-eco.com --with-model   # 额外真跑一次识别（会花钱）
set -u

BASE="${1:-http://localhost:3000}"
WITH_MODEL="${2:-}"
DEV_ID="dev_verifyscript$(date +%s)"
PASS=0; FAIL=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
head_() { printf "\n\033[1m%s\033[0m\n" "$1"; }

code() { curl -s -o /dev/null -w "%{http_code}" -m 30 "$@"; }

head_ "1. 页面可达"
for p in / /me /encounter /journeys /firsts /devices /feedback /legal/privacy /legal/terms /manifest.webmanifest /icons/icon-192.png; do
  c=$(code "$BASE$p")
  [ "$c" = "200" ] && ok "$p" || bad "$p → $c"
done

head_ "2. 健康检查与线上配置"
HEALTH=$(curl -s -m 30 "$BASE/api/health")
if echo "$HEALTH" | grep -q '"ok"'; then
  ok "/api/health 可用"
  echo "$HEALTH" | python3 -c '
import json,sys
d = json.load(sys.stdin)
m = d["model"]; q = d["quota"]
rows = [
    ("版本", str(d["version"]) + "  commit " + str(d["commit"])),
    ("视觉模型", m["vision"]),
    ("Omni", m["omni"]),
    ("接口地址", m["baseUrlHost"]),
    ("API key", "已配置" if m["apiKeyConfigured"] else "没配置"),
    ("限流后端", m and q["backend"] + ("  (单实例部署下这就是全局限流，OK)" if q["backend"] == "memory" else "")),
    ("今日已用", str(q["usedToday"]) + " / " + str(q["dailyBudget"])),
]
for k, v in rows:
    print("      " + k.ljust(10) + str(v))
'
  echo "$HEALTH" | grep -q '"apiKeyConfigured":true' && ok "模型 API key 已配置" || bad "模型 API key 没配置 —— 识别一定会失败"
else
  bad "/api/health 不可用（旧版本没有这个接口，说明代码没更新）"
fi

head_ "3. 用量护栏"
c=$(code -X POST "$BASE/api/recognize" -H "content-type: application/json" -d '{}')
[ "$c" = "401" ] && ok "无设备标识被拒（401）" || bad "无设备标识应返回 401，实际 $c"

c=$(code -X POST "$BASE/api/recognize" -H "content-type: application/json" -H "x-device-id: bad-format" -d '{}')
[ "$c" = "401" ] && ok "非法设备标识被拒（401）" || bad "非法设备标识应返回 401，实际 $c"

c=$(code -X POST "$BASE/api/recognize" -H "content-type: application/json" -H "x-device-id: ${DEV_ID}abcd" -d '{}')
[ "$c" = "400" ] && ok "合法设备标识可通过闸门（400 = 校验到了 body）" || bad "合法设备标识应返回 400，实际 $c"

head_ "4. 安全响应头"
H=$(curl -s -D- -o /dev/null -m 30 "$BASE/")
for h in "content-security-policy-report-only" "x-content-type-options" "referrer-policy" "permissions-policy"; do
  echo "$H" | grep -qi "^$h" && ok "$h" || bad "缺少 $h"
done

if [ "$WITH_MODEL" = "--with-model" ]; then
  head_ "5. 真实识别（会产生模型调用费用）"
  FIX="public/seed/coffee-cup.jpg"
  if [ ! -f "$FIX" ]; then bad "找不到测试图 $FIX"; else
    python3 - "$FIX" > /tmp/verify-req.json <<'PY'
import base64, json, sys
url = "data:image/jpeg;base64," + base64.b64encode(open(sys.argv[1],"rb").read()).decode()
json.dump({"image": url, "userNote": "我第一次见这种杯子，很特别", "history": []}, open("/dev/stdout","w"))
PY
    START=$(date +%s)
    R=$(curl -s -m 120 -X POST "$BASE/api/recognize" -H "content-type: application/json" -H "x-device-id: ${DEV_ID}abcd" -d @/tmp/verify-req.json)
    ELAPSED=$(( $(date +%s) - START ))
    if echo "$R" | grep -q '"name"'; then
      ok "识别成功（${ELAPSED}s）"
      echo "$R" | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
print("      名称  " + str(d.get("name")))
print("      判定  " + str(d.get("verdict")))
print("      幸运  " + str(d.get("luck", {}).get("text")))
print("      追问  " + str(d.get("question")))
blob = json.dumps(d, ensure_ascii=False)
hits = re.findall(r"你记录里|上一次[^。]{0,14}你|你之前见过|[0-9]{4}\s*年\s*[0-9]{1,2}\s*月", blob)
print("      [!] 疑似编造过往: " + str(hits) if hits else "      空历史下没有编造过往")
'
      [ "$ELAPSED" -gt 20 ] && bad "耗时 ${ELAPSED}s 偏慢，路演/体验会难受" || ok "耗时可接受"
    else
      bad "识别失败：$(echo "$R" | head -c 200)"
    fi
  fi
fi

head_ "结果"
printf "  通过 %d 项，失败 %d 项\n\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
