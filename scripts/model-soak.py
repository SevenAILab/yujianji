#!/usr/bin/env python3
"""
线上模型压测：同一套请求跑多轮，统计成功率、耗时和内容质量问题。

  python3 scripts/model-soak.py https://yujianji.mcs-eco.com            # 默认 2 轮
  python3 scripts/model-soak.py https://yujianji.mcs-eco.com --rounds 3

每轮：识别 5 张图（人造物/食物/动物/自然物）+ 回应 2 次 + 总结 1 次 + 视频（带音频）1 次。
会产生真实模型调用费用，大约每轮 9 次。
"""
import argparse, base64, io, json, math, re, statistics, struct, sys, time, urllib.request, wave, uuid
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("--rounds", type=int, default=2)
ap.add_argument("--workers", type=int, default=3)
args = ap.parse_args()
BASE = args.base.rstrip("/")

def img(name):
    return "data:image/jpeg;base64," + base64.b64encode(open(f"public/seed/{name}.jpg", "rb").read()).decode()

def wav():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode()

def post(path, body):
    dev = "dev_soak" + uuid.uuid4().hex[:20]
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-device-id": dev})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read()), time.time() - t
    except urllib.error.HTTPError as e:
        try: payload = json.loads(e.read())
        except Exception: payload = {}
        return e.code, payload, time.time() - t
    except Exception as e:
        return 0, {"code": type(e).__name__}, time.time() - t

FAB = re.compile(r"你记录里|上一次[^。]{0,14}你|你之前见过|[0-9]{4}\s*年\s*[0-9]{1,2}\s*月")

def recognize_issues(d):
    issues = []
    q = d.get("question") or ""
    if len(q) > 25: issues.append(f"追问{len(q)}字")
    if re.search(r"[A-Za-z]", q): issues.append("追问夹英文")
    for k in ("cognition", "fun", "memorySentence"):
        if re.search(r"[A-Za-z]{3,}", d.get(k) or ""): issues.append(f"{k}夹英文")
    if re.search(r"[A-Za-z]{3,}", (d.get("luck") or {}).get("text") or ""): issues.append("luck夹英文")
    if re.search(r"[（(]|或", d.get("name") or ""): issues.append("名称带备选")
    blob = json.dumps(d, ensure_ascii=False)
    if FAB.search(blob): issues.append("疑似编造过往")
    return issues

HISTORY = [
    {"id": "a1", "name": "银杏叶", "category": "plant", "place": "北京", "date": "2025-11-03T15:00:00+08:00", "userNote": "满地金黄"},
    {"id": "a2", "name": "拉花咖啡", "category": "food", "place": "杭州", "date": "2025-12-22T09:00:00+08:00", "userNote": "冬至那天喝的"},
    {"id": "a3", "name": "玄武岩", "category": "mineral", "place": "青海", "date": "2026-07-15T11:00:00+08:00", "userNote": "黑色的石头上有气孔"},
]

def jobs():
    for name, note in [("coffee-cup", "我第一次见这种杯子，很特别"), ("pizza", "路上随手拍的"),
                       ("dog", "路上随手拍的"), ("pink-leaf-real", "走了半天路，突然看到这一片粉色的叶子"),
                       ("ceramic-mug", "")]:
        yield ("识别", name, "/api/recognize", {"image": img(name), "userNote": note, "history": []})
    yield ("回应", "猫", "/api/reply", {"itemName": "虎斑猫", "userNote": "路上随手拍的",
           "question": "它是自己跳上去的，还是你叫它的？", "answer": "自己跳上去的，一上来就不走了"})
    yield ("回应", "叶子", "/api/reply", {"itemName": "杜鹃叶", "userNote": "走了半天路，突然看到这一片粉色的叶子",
           "question": "你是蹲下来拍的，还是站着拍的？", "answer": "蹲下来的，差点摔一跤，旁边的人都笑了"})
    yield ("总结", "三条", "/api/summary", {"history": HISTORY})
    yield ("视频", "带音频", "/api/encounter-av", {"frames": [{"dataUrl": img("dog"), "atSec": 0}, {"dataUrl": img("dog"), "atSec": 1.0}],
           "audioDataUrl": wav(), "history": [], "placeFallback": None})

def run(job):
    kind, label, path, body = job
    status, data, secs = post(path, body)
    issues = []
    if status == 200:
        if kind == "识别": issues = recognize_issues(data)
        if kind == "总结" and (data.get("summary") or "").lstrip().startswith("{"): issues.append("总结是JSON")
        if kind == "回应" and len(data.get("reply") or "") > 45: issues.append("回应超长")
        if kind == "视频" and not data.get("recognized"): issues.append("视频未识别")
    return kind, label, status, data, secs, issues

results = []
all_jobs = [j for _ in range(args.rounds) for j in jobs()]
print(f"对 {BASE} 发 {len(all_jobs)} 个请求（{args.rounds} 轮，并发 {args.workers}）…\n")
with ThreadPoolExecutor(max_workers=args.workers) as pool:
    for kind, label, status, data, secs, issues in pool.map(run, all_jobs):
        ok = status == 200
        summary = ""
        if ok and kind == "识别": summary = f"{data.get('name')} / {data.get('verdict')}"
        elif ok and kind == "回应": summary = data.get("reply")
        elif ok and kind == "总结": summary = (data.get("summary") or "")[:40]
        elif ok and kind == "视频": summary = " + ".join(s.get("name", "?") for s in data.get("segments", []))
        else: summary = f"{data.get('code')} {data.get('error', '')}"
        flag = "✓" if ok and not issues else ("△" if ok else "✗")
        print(f"  {flag} {kind:<3} {label:<14} {status} {secs:5.1f}s  {summary}" + (f"   ⚠ {', '.join(issues)}" if issues else ""))
        results.append((kind, ok, secs, issues))

print("\n══ 汇总 ══")
for kind in ("识别", "回应", "总结", "视频"):
    rows = [r for r in results if r[0] == kind]
    if not rows: continue
    oks = [r for r in rows if r[1]]
    times = sorted(r[2] for r in oks)
    p50 = statistics.median(times) if times else 0
    p90 = times[min(len(times) - 1, int(len(times) * 0.9))] if times else 0
    flagged = sum(1 for r in oks if r[3])
    print(f"  {kind}: 成功 {len(oks)}/{len(rows)}  中位 {p50:.1f}s  P90 {p90:.1f}s  内容问题 {flagged} 条")
failed = sum(1 for r in results if not r[1])
sys.exit(1 if failed else 0)
