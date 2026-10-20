"""Resume-safe Encounter photo -> local GLB pipeline.

Run the FastAPI service first, then: python -m scripts.pipeline.batch --dry-run
"""
import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.images import normalize, prepare
from scripts.pipeline.glb import normalize_glb, optimize_glb
from scripts.pipeline.rarity import fallback_rarity, score_rarity

VERSION = "encounter-v1"
TERMINAL = {"success", "failed", "cancelled", "submission_unknown"}


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_encounters(path: Path) -> list[dict]:
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise ValueError("encounters.json 必须为数组")
    ids = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not record["id"]:
            raise ValueError("每条 Encounter 必须有 id")
        if record["id"] in ids or not re.fullmatch(r"[a-zA-Z0-9_-]+", record["id"]):
            raise ValueError(f"id 重复或不适合作文件名: {record['id']}")
        ids.add(record["id"])
        for field in ("photoUrl", "label", "capturedAt"):
            if not isinstance(record.get(field), str) or not record[field]:
                raise ValueError(f"{record['id']} 缺少 {field}")
        if not isinstance(record.get("firstSeen"), bool):
            raise ValueError(f"{record['id']} 的 firstSeen 必须为布尔值")
    return records


def photo_path(url: str, public_root: Path, input_path: Path) -> Path:
    # The batch is intentionally offline: no SSRF and no expiring remote photos.
    if url.startswith("/assets/"):
        root = public_root.resolve()
        path = (root / url.lstrip("/")).resolve()
    elif not urlparse(url).scheme and not url.startswith("/"):
        root = input_path.parent.resolve()
        path = (root / url).resolve()
    else:
        raise ValueError(f"仅支持本地 photoUrl: {url}")
    if not path.is_relative_to(root):
        raise ValueError("photoUrl 越过允许的目录")
    return path


def subject_config(record: dict, overrides: dict | None = None) -> dict:
    config = (overrides or {}).get(record["id"], record.get("pipeline", {}))
    if not isinstance(config, dict):
        raise ValueError("pipeline 配置必须为对象")
    category = config.get("category")
    allowed = {"character", "creature", "furniture", "prop", "weapon", "vehicle", "building", "plant", "other"}
    if category is not None and category not in allowed:
        raise ValueError(f"无效 category: {category}")
    bbox = config.get("bbox", [0, 0, 1, 1])
    if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(x, (int, float)) for x in bbox):
        raise ValueError("pipeline.bbox 必须为四个数字")
    x1, y1, x2, y2 = bbox
    if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
        raise ValueError("pipeline.bbox 坐标无效")
    quality = config.get("quality", "standard")
    if quality not in ("standard", "high"):
        raise ValueError("pipeline.quality 必须为 standard/high")
    input_mode = config.get("inputMode", "object")
    if input_mode not in ("object", "environment"):
        raise ValueError("pipeline.inputMode 必须为 object/environment")
    if input_mode == "environment" and config.get("removeBackground", False):
        raise ValueError("环境模式不能抠背景")
    return {"category": category, "bbox": bbox, "quality": quality,
            "input_mode": input_mode,
            "remove_background": bool(config.get("removeBackground", False)),
            "yaw": float(config.get("yaw", 0))}


def fingerprint(raw: bytes, config: dict) -> str:
    settings = {key: value for key, value in config.items()
                if key != "yaw" and not (key == "input_mode" and value == "object")}
    return hashlib.sha256(raw + json.dumps(settings, sort_keys=True).encode() + VERSION.encode()).hexdigest()


def headers(service_key: str = "") -> dict:
    return {"X-Service-Key": service_key} if service_key else {}


def download_glb(client: httpx.Client, url: str, dest: Path):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Tripo 返回的模型 URL 非 HTTPS")
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_suffix(".glb.part")
    with client.stream("GET", url, follow_redirects=True, timeout=180) as response:
        response.raise_for_status()
        total = 0
        with temporary.open("wb") as output:
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > 500 * 1024 * 1024:
                    raise ValueError("GLB 超过 500 MB")
                output.write(chunk)
    with temporary.open("rb") as uploaded:
        magic = uploaded.read(4)
    if temporary.stat().st_size < 20 or magic != b"glTF":
        raise ValueError("下载结果不是 GLB")
    temporary.replace(dest)


def rating(record: dict, cache: dict, client: httpx.Client) -> dict:
    key = record["label"].strip().lower()
    cached = cache.get(key)
    api_key = os.getenv("OPENAI_API_KEY")
    if cached is None and api_key:
        schema = {"type": "object", "properties": {
            "commonness": {"type": "integer"}, "reason": {"type": "string"}},
            "required": ["commonness", "reason"], "additionalProperties": False}
        payload = {"model": os.getenv("RARITY_MODEL", "gpt-4o-mini"), "store": False,
                   "input": [{"role": "user", "content": (
                       f"给物品类别“{record['label']}”评估定性的常见度 0..100（越高越常见）。"
                       "只基于一般物品类别，不假定地点、目击人数或真实统计数据。"
                       "reason 用一句中文解释外观或类别，不写数字、百分比或无依据事实。") }],
                   "text": {"format": {"type": "json_schema", "name": "rarity_prior",
                                       "strict": True, "schema": schema}}}
        try:
            response = client.post("https://api.openai.com/v1/responses", json=payload,
                                   headers={"Authorization": f"Bearer {api_key}"}, timeout=45)
            response.raise_for_status()
            result = response.json()
            message = next(item for item in result["output"] if item["type"] == "message")
            content = next(item["text"] for item in message["content"] if item["type"] == "output_text")
            candidate = json.loads(content)
            score_rarity(candidate["commonness"], record["firstSeen"], candidate["reason"])
            cached = candidate
            cache[key] = cached
        except (httpx.HTTPError, KeyError, StopIteration, ValueError, TypeError):
            pass
    if cached is None:
        return fallback_rarity()
    try:
        return score_rarity(cached["commonness"], record["firstSeen"], cached["reason"])
    except (KeyError, ValueError, TypeError):
        return fallback_rarity()


def run(args, client: httpx.Client):
    source = Path(args.input).resolve()
    public = Path(args.public_root).resolve()
    records = read_encounters(source)
    subjects_file = Path(getattr(args, "subjects", "scripts/pipeline/subjects.json"))
    overrides = json.loads(subjects_file.read_text(encoding="utf-8")) if subjects_file.exists() else {}
    if not isinstance(overrides, dict):
        raise ValueError("subjects.json 必须为 id 到配置的对象")
    state_file = Path(args.state).resolve() if args.state else public.parent / ".pipeline" / "state.json"
    state = json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {"jobs": {}, "rarityCache": {}}
    state.setdefault("jobs", {})
    state.setdefault("rarityCache", {})
    planned = []
    for record in records:
        config = subject_config(record, overrides)
        path = photo_path(record["photoUrl"], public, source)
        raw = path.read_bytes()
        normalize(raw)  # reject bad input before a paid operation
        key = fingerprint(raw, config)
        job = state["jobs"].get(record["id"], {})
        if job.get("fingerprint") != key:
            job = {"fingerprint": key, "state": "new", "idempotencyKey": f"encounter-{record['id']}-{key[:24]}"}
        planned.append((record, config, raw, job))
    if args.dry_run:
        for record, config, _raw, job in planned:
            print(f"{record['id']}: {job['state']} -> {config['quality']}")
        new_count = sum(job["state"] == "new" for _, _, _, job in planned)
        print(f"待提交 {new_count} 个付费任务；积分取决于 Tripo 实际计费")
        return

    service_headers = headers(os.getenv("SERVICE_API_KEY", ""))
    for record, config, raw, job in planned:
        identity = record["id"]
        state["jobs"][identity] = job
        atomic_json(state_file, state)
        try:
            final_model = public / "assets" / "models" / f"{identity}.glb"
            if (job["state"] == "success" and final_model.is_file()
                    and isinstance(record.get("model"), dict)
                    and record["model"].get("glbUrl") == f"/assets/models/{identity}.glb"
                    and record.get("rarity") and job.get("finalYaw") == config["yaw"]
                    and job.get("optimized") == (not args.no_optimize)):
                print(f"{identity}: cached")
                continue
            image = normalize(raw)
            if config["category"] is not None and config["input_mode"] == "object":
                # Fail before paid submission if optional background removal is unavailable.
                prepared = prepare(image, tuple(config["bbox"]), config["remove_background"])
                cutout = public / "assets" / "cutouts" / f"{identity}.png"
                cutout.parent.mkdir(parents=True, exist_ok=True)
                cutout.write_bytes(prepared)
                record["cutoutUrl"] = f"/assets/cutouts/{identity}.png"
            if job["state"] in ("new", "submitting"):
                job["state"] = "submitting"
                atomic_json(state_file, state)
                form = {"quality": config["quality"], "remove_background": str(config["remove_background"]).lower(),
                        "input_mode": config["input_mode"]}
                if config["category"]:
                    form.update({"category": config["category"], "target_name": record["label"],
                                 "bbox": ",".join(map(str, config["bbox"]))})
                response = client.post(f"{args.api_url.rstrip('/')}/v1/image-to-3d",
                                       files={"file": (f"{identity}.png", raw, "image/png")},
                                       data=form, headers={**service_headers, "Idempotency-Key": job["idempotencyKey"]},
                                       timeout=120)
                response.raise_for_status()
                result = response.json()
                job.update(state=result["state"], generationId=result["generation_id"], taskId=result.get("task_id"))
                atomic_json(state_file, state)
            if "cutoutUrl" not in record and config["input_mode"] == "object":
                # Reuse the exact analysis/selected object that the direct API created.
                aid = hashlib.sha256(job["idempotencyKey"].encode() + b"\0" + raw).hexdigest()[:32]
                response = client.get(f"{args.api_url.rstrip('/')}/v1/analyses/{aid}",
                                      headers=service_headers, timeout=60)
                response.raise_for_status()
                objects = response.json()["objects"]
                if len(objects) == 1:
                    response = client.get(f"{args.api_url.rstrip('/')}/v1/analyses/{aid}/objects/{objects[0]['id']}/preview",
                                          params={"remove_background": config["remove_background"]},
                                          headers=service_headers, timeout=120)
                    response.raise_for_status()
                    cutout = public / "assets" / "cutouts" / f"{identity}.png"
                    cutout.parent.mkdir(parents=True, exist_ok=True)
                    cutout.write_bytes(response.content)
                    record["cutoutUrl"] = f"/assets/cutouts/{identity}.png"
            if job["state"] == "submission_unknown":
                raise RuntimeError("Tripo 提交结果不明，须核对控制台")
            if job["state"] not in ("success", "failed", "cancelled"):
                deadline = time.monotonic() + args.timeout
                while time.monotonic() < deadline:
                    response = client.get(f"{args.api_url.rstrip('/')}/v1/generations/{job['generationId']}",
                                          headers=service_headers, timeout=60)
                    response.raise_for_status()
                    result = response.json()
                    job.update(state=result["state"], progress=result.get("progress"))
                    if result.get("output"):
                        job["output"] = result["output"]
                    if result.get("credits_consumed") is not None:
                        job["credits"] = result["credits_consumed"]
                    atomic_json(state_file, state)
                    if job["state"] in TERMINAL:
                        break
                    time.sleep(args.poll_seconds)
                if job["state"] not in TERMINAL:
                    print(f"{identity}: still running; resume later")
                    continue
            if job["state"] != "success":
                print(f"{identity}: {job['state']}; manual review required")
                continue
            raw_glb = state_file.parent / "raw" / f"{identity}-{job['fingerprint'][:12]}.glb"
            if not raw_glb.exists():
                url = job.get("output", {}).get("model_url")
                if not url:
                    raise ValueError("任务成功但缺少 model_url")
                download_glb(client, url, raw_glb)
            normalized = state_file.parent / "normalized" / f"{identity}-{job['fingerprint'][:12]}-{config['yaw']}.glb"
            bbox = normalize_glb(raw_glb, normalized, config["yaw"])
            target = public / "assets" / "models" / f"{identity}.glb"
            metrics = optimize_glb(normalized, target, enabled=not args.no_optimize)
            record["model"] = {"glbUrl": f"/assets/models/{identity}.glb", "bbox": bbox}
            record["rarity"] = rating(record, state["rarityCache"], client)
            atomic_json(source, records)
            job["finalYaw"] = config["yaw"]
            job["optimized"] = not args.no_optimize
            atomic_json(state_file, state)
            print(f"{identity}: ready {metrics['bytes'] / 1048576:.1f} MiB, {metrics['faces']} faces; credits={job.get('credits', '?')}")
        except (httpx.HTTPError, OSError, ValueError, RuntimeError, KeyError) as exc:
            job["error"] = str(exc)[:300]
            atomic_json(state_file, state)
            print(f"{identity}: {job['error']}; resume after fixing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="public/assets/encounters.json")
    parser.add_argument("--public-root", default="public")
    parser.add_argument("--subjects", default="scripts/pipeline/subjects.json")
    parser.add_argument("--state")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-optimize", action="store_true")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--poll-seconds", type=int, default=10)
    args = parser.parse_args()
    with httpx.Client() as client:
        run(args, client)


if __name__ == "__main__":
    main()
