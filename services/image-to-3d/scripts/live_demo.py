"""Manual end-to-end smoke test. Uses TRIPO_API_KEY from the environment only."""
import argparse
import os
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi.testclient import TestClient

from app.main import app, connect


SAMPLES = [
    ("oak-tankard", "prop", "木质酒杯"),
    ("mushroom-creature", "creature", "蘑菇生物"),
]


def download(url: str, dest: Path, magic: bytes | None = None):
    last_error = None
    for trust_env in (True, False):
        for attempt in range(3):
            try:
                with httpx.Client(follow_redirects=True, timeout=120, trust_env=trust_env) as client:
                    with client.stream("GET", url) as response:
                        response.raise_for_status()
                        with dest.open("wb") as output:
                            for chunk in response.iter_bytes():
                                output.write(chunk)
                if magic and dest.read_bytes()[:len(magic)] != magic:
                    raise RuntimeError(f"下载文件格式不符: {dest}")
                print(f"saved {dest} ({dest.stat().st_size} bytes)", flush=True)
                return
            except (httpx.HTTPError, RuntimeError) as exc:
                last_error = exc
                time.sleep(attempt + 1)
    raise RuntimeError(f"下载 {urlparse(url).netloc} 失败: {last_error}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--balance-only", action="store_true")
    parser.add_argument("--only", choices=[name for name, _, _ in SAMPLES])
    parser.add_argument("--resume", action="store_true", help="只查询本地已有任务，不重新提交")
    args = parser.parse_args()
    if not os.getenv("TRIPO_API_KEY"):
        raise SystemExit("请先设置 TRIPO_API_KEY 环境变量")
    base = os.getenv("TRIPO_BASE_URL", "https://openapi.tripo3d.ai/v3").rstrip("/")
    if not args.resume:
        with httpx.Client(timeout=30) as http:
            balance = http.get(f"{base}/account/balance", headers={
                "Authorization": f"Bearer {os.environ['TRIPO_API_KEY']}"})
            print(f"balance HTTP {balance.status_code}: {balance.text[:500]}", flush=True)
            balance.raise_for_status()
    if args.balance_only:
        return

    outputs = Path("examples")
    chosen = [sample for sample in SAMPLES if not args.only or sample[0] == args.only]
    jobs = []
    with TestClient(app) as client:
        headers = {"X-Service-Key": os.environ.get("SERVICE_API_KEY", "")}
        for name, category, display_name in chosen:
            idem_key = f"live-demo-20260922-{name}"
            if args.resume:
                with connect() as db:
                    row = db.execute("SELECT id FROM generations WHERE idem_key=?", (idem_key,)).fetchone()
                if row is None:
                    raise RuntimeError(f"未找到已有任务: {name}")
                jobs.append((name, row["id"]))
            else:
                path = outputs / f"{name}.png"
                with path.open("rb") as image:
                    response = client.post("/v1/image-to-3d",
                        files={"file": (path.name, image, "image/png")},
                        data={"category": category, "target_name": display_name, "quality": "high"},
                        headers={**headers, "Idempotency-Key": idem_key})
                print(f"{name}: submit HTTP {response.status_code}: {response.text[:700]}", flush=True)
                response.raise_for_status()
                jobs.append((name, response.json()["generation_id"]))

        deadline = time.monotonic() + 900
        pending = dict(jobs)
        while pending and time.monotonic() < deadline:
            for name, generation_id in list(pending.items()):
                response = client.get(f"/v1/generations/{generation_id}", headers=headers)
                response.raise_for_status()
                status = response.json()
                print(f"{name}: {status['state']} {status.get('progress')}%", flush=True)
                if status["state"] == "success":
                    result = status.get("output") or {}
                    print(f"{name}: output fields={list(result)}", flush=True)
                    if result.get("model_url"):
                        try:
                            download(result["model_url"], outputs / f"{name}.glb", b"glTF")
                        except RuntimeError as exc:
                            print(f"{name}: {exc}", flush=True)
                    if result.get("rendered_image_url"):
                        try:
                            download(result["rendered_image_url"], outputs / f"{name}-preview.webp")
                        except RuntimeError as exc:
                            print(f"{name}: {exc}", flush=True)
                    pending.pop(name)
                elif status["state"] in ("failed", "cancelled", "submission_unknown"):
                    print(f"{name}: terminal error={status}", flush=True)
                    pending.pop(name)
            if pending:
                time.sleep(10)
        if pending:
            print(f"仍在运行: {pending}", flush=True)


if __name__ == "__main__":
    main()
