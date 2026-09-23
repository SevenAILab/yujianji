"""示例照片 → Tripo → GLB（离线预生成，演示现场不等 Tripo）。

与后端 app/providers.py 同一套 Tripo v3 调用：上传裁切后的主体 → image-to-model → 轮询 → 下载。
- 密钥只从环境变量 TRIPO_API_KEY 读，不落盘。
- 每个 id 的 task_id 记在 STATE（仓库外），重跑只查询不重复提交；提交结果不明的标 submission_unknown，绝不自动重交。
- 原始 GLB 存仓库外 CACHE；压缩后的前端 GLB 由 optimize.sh 生成到 public/assets/models/demo/。

用法：TRIPO_API_KEY=... python3 scripts/demo-3d/generate.py [--only id1,id2] [--dry-run]
"""
import argparse, io, json, os, sys, time, urllib.request
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get("DEMO_3D_CACHE", ROOT.parent / "demo-3d-cache"))
STATE = CACHE / "state.json"
BASE = os.environ.get("TRIPO_BASE_URL", "https://openapi.tripo3d.ai/v3").rstrip("/")
MODEL = "v3.1-20260211"


def prepare(photo: Path, bbox) -> bytes:
    """同 app/images.prepare：按框裁主体、四周留 8%、放到浅灰方形画布"""
    image = ImageOps.exif_transpose(Image.open(photo)).convert("RGB")
    w, h = image.size
    x1, y1, x2, y2 = bbox
    mx, my = (x2 - x1) * .08, (y2 - y1) * .08
    subject = image.crop((max(0, int((x1 - mx) * w)), max(0, int((y1 - my) * h)), min(w, int((x2 + mx) * w)), min(h, int((y2 + my) * h))))
    subject.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    side = max(512, int(max(subject.size) / .82))
    canvas = Image.new("RGB", (side, side), (245, 245, 245))
    canvas.paste(subject, ((side - subject.width) // 2, (side - subject.height) // 2))
    out = io.BytesIO()
    canvas.save(out, "PNG", optimize=True)
    return out.getvalue()


def call(method, url, key, *, body=None, headers=None, timeout=120):
    request = urllib.request.Request(url, data=body, method=method, headers={"Authorization": f"Bearer {key}", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())
    if payload.get("code") != 0:
        raise RuntimeError(f"Tripo code={payload.get('code')} {str(payload.get('message'))[:120]}")
    return payload["data"]


def upload(key, png: bytes) -> str:
    boundary = "----demo3d" + os.urandom(8).hex()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"subject.png\"\r\nContent-Type: image/png\r\n\r\n").encode() + png + f"\r\n--{boundary}--\r\n".encode()
    for attempt in range(3):  # 上传是幂等的，可以重试
        try:
            return call("POST", f"{BASE}/files", key, body=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})["file_token"]
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def save(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.replace(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    key = os.environ.get("TRIPO_API_KEY", "")
    subjects = json.loads((ROOT / "scripts/demo-3d/subjects.json").read_text())
    ids = [i for i in subjects if not args.only or i in args.only.split(",")]
    CACHE.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    todo = [i for i in ids if state.get(i, {}).get("state") not in ("success", "submitted", "running", "queued", "submission_unknown")]
    print(f"{len(ids)} 个主体，需新提交 {len(todo)} 个（standard 档约 30 积分/个）")
    if args.dry_run:
        return
    if not key:
        sys.exit("缺少 TRIPO_API_KEY")

    for item_id in todo:
        png = prepare(ROOT / subjects[item_id]["photo"], subjects[item_id]["bbox"])
        (CACHE / f"{item_id}-input.png").write_bytes(png)
        token = upload(key, png)
        state[item_id] = {"state": "submitting"}
        save(state)
        try:
            task = call("POST", f"{BASE}/generation/image-to-model", key, body=json.dumps({
                "input": token, "model": MODEL, "texture": True, "pbr": True,
                "texture_quality": "standard", "geometry_quality": "standard", "enable_image_autofix": True,
            }).encode(), headers={"Content-Type": "application/json"})
            state[item_id] = {"state": "submitted", "taskId": task["task_id"]}
        except Exception as exc:  # 付费请求：结果不明就停下来人工核对，不重交
            state[item_id] = {"state": "submission_unknown", "error": str(exc)[:200]}
        save(state)
        print(item_id, state[item_id]["state"], flush=True)

    # 已提交但还没把 GLB 落到本地的都要继续查（成功了但下载断掉的也算）
    pending = [i for i in ids if state.get(i, {}).get("taskId") and not (CACHE / f"{i}-raw.glb").exists() and state[i]["state"] not in ("failed", "cancelled", "banned", "expired")]
    deadline = time.time() + 40 * 60
    while pending and time.time() < deadline:
        for item_id in list(pending):
            try:
                task = call("GET", f"{BASE}/tasks/{state[item_id]['taskId']}", key, timeout=60)
            except Exception as exc:
                print(item_id, "查询失败，稍后再试", str(exc)[:80], flush=True)
                continue
            status = task.get("status")
            state[item_id].update({"state": status, "progress": task.get("progress"), "credits": task.get("consumed_credit") or task.get("credits")})
            if status == "success":
                url = (task.get("output") or {}).get("pbr_model") or (task.get("output") or {}).get("model_url") or (task.get("output") or {}).get("model")
                raw = CACHE / f"{item_id}-raw.glb"
                data = b""
                for attempt in range(4):  # 下载是幂等的；网络偶尔断 SSL，重试即可
                    try:
                        with urllib.request.urlopen(url, timeout=300) as response:
                            data = response.read()
                        break
                    except Exception as exc:
                        print(item_id, "下载失败，重试", str(exc)[:60], flush=True)
                        time.sleep(3 * (attempt + 1))
                if data[:4] != b"glTF":
                    print(item_id, "下载未完成，下一轮再试", flush=True)
                    save(state)
                    continue
                raw.write_bytes(data)
                state[item_id]["raw"] = str(raw)
                state[item_id]["bytes"] = len(data)
                pending.remove(item_id)
            elif status in ("failed", "cancelled", "banned", "expired", "unknown"):
                state[item_id]["error"] = str(task.get("error_msg") or task)[:200]
                pending.remove(item_id)
            save(state)
            print(item_id, status, task.get("progress"), flush=True)
        if pending:
            time.sleep(15)
    print(json.dumps({i: state.get(i, {}).get("state") for i in ids}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
