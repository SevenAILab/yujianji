"""Reusable image-to-3D API. Run with `uvicorn app.main:app`."""
import hashlib
import asyncio
import json
import os
import re
import sqlite3
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, model_validator
from PIL import Image

from .images import MAX_UPLOAD, normalize, prepare, prepare_environment
from .exports import download_model
from .providers import ProviderError, Tripo, recognize
from scripts.pipeline.glb import export_glb

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()
DB = DATA_DIR / "jobs.sqlite3"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def connect():
    db = sqlite3.connect(DB, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY, objects TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        vision_status TEXT NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
        analysis_id TEXT NOT NULL, object_id TEXT NOT NULL, state TEXT NOT NULL,
        task_id TEXT, error TEXT, FOREIGN KEY (analysis_id) REFERENCES analyses(id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS detected_objects (
        id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, name TEXT NOT NULL,
        category TEXT NOT NULL, review_status TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id))""")
    db.execute("""CREATE INDEX IF NOT EXISTS detected_objects_category ON detected_objects(category)""")
    db.execute("""CREATE TABLE IF NOT EXISTS object_tags (
        object_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (object_id, tag),
        FOREIGN KEY (object_id) REFERENCES detected_objects(id))""")
    db.execute("""CREATE INDEX IF NOT EXISTS object_tags_tag ON object_tags(tag)""")
    db.execute("""CREATE TABLE IF NOT EXISTS generation_batches (
        idem_key TEXT PRIMARY KEY, digest TEXT NOT NULL, analysis_id TEXT NOT NULL)""")
    if db.execute("PRAGMA user_version").fetchone()[0] < 1:
        for row in db.execute("SELECT id,objects FROM analyses").fetchall():
            objects = json.loads(row["objects"])
            for obj in objects:
                obj.setdefault("tags", [])
                obj.setdefault("review_status", "ready")
                index_object(db, row["id"], obj)
            db.execute("UPDATE analyses SET objects=? WHERE id=?",
                       (json.dumps(objects, ensure_ascii=False), row["id"]))
        db.execute("PRAGMA user_version=1")
    db.commit()
    return db


@asynccontextmanager
async def lifespan(app: FastAPI):
    with connect():
        pass
    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
        app.state.http = client
        from . import universe
        await universe.start(app)
        try:
            yield
        finally:
            await universe.stop(app)


app = FastAPI(title="Image to 3D API", version="0.1.0", lifespan=lifespan)


def authorize(x_service_key: str | None = Header(default=None)):
    expected = os.getenv("SERVICE_API_KEY")
    if expected and x_service_key != expected:
        raise HTTPException(401, "服务访问密钥无效")


def tripo(request: Request) -> Tripo:
    key = os.getenv("TRIPO_API_KEY")
    if not key:
        raise HTTPException(503, "未配置 TRIPO_API_KEY")
    return Tripo(request.app.state.http, key, os.getenv("TRIPO_BASE_URL", "https://openapi.tripo3d.ai/v3"))


def analysis_row(analysis_id: str):
    with connect() as db:
        row = db.execute("SELECT * FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "分析不存在")
    return row


def public_analysis(row):
    return {"analysis_id": row["id"], "width": row["width"], "height": row["height"],
            "vision_status": row["vision_status"],
            "objects": [present_object(o) for o in analysis_objects(row["id"])]}


def analysis_objects(analysis_id: str) -> list[dict]:
    with connect() as db:
        row = db.execute("SELECT objects FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    return json.loads(row["objects"]) if row else []


def index_object(db: sqlite3.Connection, analysis_id: str, obj: dict):
    db.execute("INSERT OR REPLACE INTO detected_objects VALUES (?,?,?,?,?,?)",
               (obj["id"], analysis_id, obj["name"], obj["category"], obj["review_status"],
                json.dumps(obj, ensure_ascii=False)))
    db.execute("DELETE FROM object_tags WHERE object_id=?", (obj["id"],))
    db.executemany("INSERT INTO object_tags VALUES (?,?)", ((obj["id"], tag) for tag in obj["tags"]))


def save_objects(analysis_id: str, objects: list[dict]):
    with connect() as db:
        db.execute("UPDATE analyses SET objects=? WHERE id=?", (json.dumps(objects, ensure_ascii=False), analysis_id))
        for obj in objects:
            index_object(db, analysis_id, obj)


def get_object(analysis_id: str, object_id: str) -> dict:
    with connect() as db:
        row = db.execute("SELECT payload FROM detected_objects WHERE analysis_id=? AND id=?",
                         (analysis_id, object_id)).fetchone()
    if row is None:
        raise HTTPException(404, "主体不存在")
    return json.loads(row["payload"])


def recommended_quality(category: str) -> str:
    return "high" if category in {"character", "creature", "vehicle", "building"} else "standard"


def present_object(obj: dict) -> dict:
    return {**obj, "recommended_quality": recommended_quality(obj["category"])}


class Subject(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    category: Literal["character", "creature", "furniture", "prop", "weapon", "vehicle", "building", "plant", "other"]
    bbox: tuple[float, float, float, float]
    description: str = Field(default="", max_length=500)
    confidence: float = Field(default=1, ge=0, le=1)
    occluded: bool = False
    tags: list[str] = Field(default_factory=list, max_length=8)
    review_status: Literal["ready", "needs_review", "rejected"] = "ready"

    @model_validator(mode="after")
    def check_box(self):
        x1, y1, x2, y2 = self.bbox
        if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
            raise ValueError("bbox 必须为归一化的 [x1,y1,x2,y2]")
        cleaned = [tag.strip().lower() for tag in self.tags]
        if any(not tag or len(tag) > 40 for tag in cleaned) or len(set(cleaned)) != len(cleaned):
            raise ValueError("标签须为 1..40 字符且不能重复")
        self.tags = cleaned
        return self


class SubjectUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    bbox: tuple[float, float, float, float] | None = None
    description: str | None = None
    confidence: float | None = None
    occluded: bool | None = None
    tags: list[str] | None = None
    review_status: Literal["ready", "needs_review", "rejected"] | None = None


class GenerateBody(BaseModel):
    analysis_id: str
    object_id: str
    quality: Literal["auto", "standard", "high"] = "auto"
    remove_background: bool = False
    input_mode: Literal["object", "environment"] = "object"


class BatchGenerateBody(BaseModel):
    object_ids: list[str] = Field(min_length=1, max_length=8)
    quality: Literal["auto", "standard", "high"] = "auto"
    remove_background: bool = False

    @model_validator(mode="after")
    def unique_objects(self):
        if len(set(self.object_ids)) != len(self.object_ids):
            raise ValueError("object_ids 不能重复")
        return self


def image_path(analysis_id: str) -> Path:
    return DATA_DIR / f"{analysis_id}.png"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/analyses", dependencies=[Depends(authorize)])
async def analyze(request: Request, file: UploadFile = File(...)):
    raw = await file.read(MAX_UPLOAD + 1)
    return await create_analysis(request, raw, uuid.uuid4().hex)


async def create_analysis(request: Request, raw: bytes, aid: str, use_vision: bool = True):
    # Deterministic aid is used by the direct endpoint so a retried upload maps
    # to the same objects and the same billable idempotency key.
    if image_path(aid).exists():
        try:
            return public_analysis(analysis_row(aid))
        except HTTPException:
            pass
    try:
        image = normalize(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    buf = BytesIO()
    image.save(buf, "PNG")
    image_data = buf.getvalue()
    vision_status = "not_configured"
    objects = []
    if use_vision and os.getenv("OPENAI_API_KEY"):
        try:
            # A bounded copy prevents unnecessarily costly vision input for huge photos.
            preview = image.copy().convert("RGB")
            preview.thumbnail((1600, 1600))
            vision_buf = BytesIO()
            preview.save(vision_buf, "JPEG", quality=85)
            objects = await recognize(request.app.state.http, os.environ["OPENAI_API_KEY"],
                                      os.getenv("VISION_MODEL") or "gpt-4o-mini", vision_buf.getvalue())
            vision_status = "ok" if objects else "no_subjects"
        except ProviderError:
            vision_status = "unavailable"
    validated = []
    for candidate in objects:
        try:
            candidate["review_status"] = ("needs_review" if candidate.get("occluded") or
                                          candidate.get("confidence", 0) < .7 else "ready")
            obj = Subject.model_validate(candidate).model_dump()
        except ValueError:
            continue
        obj["id"] = uuid.uuid4().hex
        validated.append(obj)
    if vision_status == "ok" and not validated:
        vision_status = "no_subjects"
    image_path(aid).write_bytes(image_data)
    with connect() as db:
        db.execute("INSERT OR IGNORE INTO analyses VALUES (?,?,?,?,?)",
                   (aid, json.dumps(validated, ensure_ascii=False), image.width, image.height, vision_status))
        for obj in validated:
            index_object(db, aid, obj)
    return public_analysis(analysis_row(aid))


@app.post("/v1/image-to-3d", status_code=202, dependencies=[Depends(authorize)])
async def image_to_3d(
    request: Request,
    file: UploadFile = File(...),
    quality: Literal["auto", "standard", "high"] = Form("auto"),
    remove_background: bool = Form(False),
    input_mode: Literal["object", "environment"] = Form("object"),
    target_index: int | None = Form(None),
    target_name: str | None = Form(None),
    category: Literal["character", "creature", "furniture", "prop", "weapon", "vehicle", "building", "plant", "other"] | None = Form(None),
    bbox: str | None = Form(None),
    idempotency_key: str = Header(...),
    provider: Tripo = Depends(tripo),
):
    if not (1 <= len(idempotency_key) <= 128):
        raise HTTPException(422, "Idempotency-Key 长度必须在 1..128")
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(422, "图片超过 20 MB")
    aid = hashlib.sha256(idempotency_key.encode() + b"\0" + raw).hexdigest()[:32]
    analysis = await create_analysis(request, raw, aid, use_vision=category is None)
    objects = analysis["objects"]
    if category is not None:
        try:
            coords = tuple(float(part.strip()) for part in bbox.split(",")) if bbox else (0., 0., 1., 1.)
            manual = Subject(name=target_name or "指定主体", category=category, bbox=coords)
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "bbox 应为 0..1 的四个逗号分隔坐标") from exc
        # Reuse the same manual object on an idempotent retry.
        chosen = next((o for o in objects if o["name"] == manual.name and o["category"] == category
                       and list(o["bbox"]) == list(manual.bbox)), None)
        if chosen is None:
            chosen = add_subject(aid, manual)
    elif not objects:
        raise HTTPException(422, {"message": "未识别到主体；请传 category 和可选 bbox 手动指定", "analysis_id": aid})
    elif target_index is None and len(objects) != 1:
        raise HTTPException(409, {"message": "图片包含多个主体；请用 target_index 指定一个（从 0 开始）",
                                  "analysis_id": aid, "objects": objects})
    elif target_index is not None and not 0 <= target_index < len(objects):
        raise HTTPException(422, "target_index 超出主体列表范围")
    else:
        chosen = objects[target_index or 0]
    body = GenerateBody(analysis_id=aid, object_id=chosen["id"], quality=quality,
                        remove_background=remove_background, input_mode=input_mode)
    return await generate(body, request, idempotency_key, provider)


@app.get("/v1/analyses/{analysis_id}", dependencies=[Depends(authorize)])
def get_analysis(analysis_id: str):
    return public_analysis(analysis_row(analysis_id))


@app.post("/v1/analyses/{analysis_id}/objects", dependencies=[Depends(authorize)])
def add_subject(analysis_id: str, subject: Subject):
    analysis_row(analysis_id)
    objects = analysis_objects(analysis_id)
    obj = subject.model_dump()
    obj["id"] = uuid.uuid4().hex
    objects.append(obj)
    save_objects(analysis_id, objects)
    return present_object(obj)


@app.patch("/v1/analyses/{analysis_id}/objects/{object_id}", dependencies=[Depends(authorize)])
def update_subject(analysis_id: str, object_id: str, subject: SubjectUpdate):
    analysis_row(analysis_id)
    objects = analysis_objects(analysis_id)
    for index, obj in enumerate(objects):
        if obj["id"] == object_id:
            updated = Subject.model_validate({**obj, **subject.model_dump(exclude_unset=True)}).model_dump()
            updated["id"] = object_id
            if (any_generation_for_object(object_id) and
                    (list(updated["bbox"]) != list(obj["bbox"]) or updated["category"] != obj["category"])):
                raise HTTPException(409, "该主体已有建模任务，不能修改裁切框或类别；可修改标签等元数据")
            objects[index] = updated
            save_objects(analysis_id, objects)
            return present_object(updated)
    raise HTTPException(404, "主体不存在")


def any_generation_for_object(object_id: str) -> bool:
    with connect() as db:
        return db.execute("SELECT 1 FROM generations WHERE object_id=? LIMIT 1", (object_id,)).fetchone() is not None


@app.get("/v1/objects", dependencies=[Depends(authorize)])
def list_objects(category: str | None = None, tag: str | None = None,
                 review_status: Literal["ready", "needs_review", "rejected"] | None = None,
                 limit: int = 50, offset: int = 0):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(422, "limit/offset 无效")
    filters, params = [], []
    if category:
        filters.append("o.category=?")
        params.append(category)
    if tag:
        filters.append("EXISTS (SELECT 1 FROM object_tags t WHERE t.object_id=o.id AND t.tag=?)")
        params.append(tag.strip().lower())
    if review_status:
        filters.append("o.review_status=?")
        params.append(review_status)
    where = " WHERE " + " AND ".join(filters) if filters else ""
    with connect() as db:
        total = db.execute("SELECT count(*) FROM detected_objects o" + where, params).fetchone()[0]
        rows = db.execute("SELECT o.analysis_id,o.payload FROM detected_objects o" + where +
                          " ORDER BY o.rowid DESC LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
    return {"total": total, "objects": [{"analysis_id": row["analysis_id"],
             **present_object(json.loads(row["payload"]))} for row in rows]}


@app.get("/v1/analyses/{analysis_id}/objects/{object_id}/preview", dependencies=[Depends(authorize)])
def preview(analysis_id: str, object_id: str, remove_background: bool = False):
    obj = get_object(analysis_id, object_id)
    try:
        data = prepared_object(analysis_id, obj, remove_background)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(data, media_type="image/png")


def prepared_object(analysis_id: str, obj: dict, remove_background: bool) -> bytes:
    settings = json.dumps([obj["bbox"], remove_background]).encode()
    digest = hashlib.sha256(settings).hexdigest()[:16]
    path = DATA_DIR / "cutouts" / f"{analysis_id}-{obj['id']}-{digest}.png"
    if not path.exists():
        with Image.open(image_path(analysis_id)) as image:
            data = prepare(image, tuple(obj["bbox"]), remove_background)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
    return path.read_bytes()


@app.post("/v1/analyses/{analysis_id}/generations", status_code=202,
          dependencies=[Depends(authorize)])
async def generate_objects(analysis_id: str, body: BatchGenerateBody, request: Request,
                           idempotency_key: str = Header(...), provider: Tripo = Depends(tripo)):
    if not (1 <= len(idempotency_key) <= 128):
        raise HTTPException(422, "Idempotency-Key 长度必须在 1..128")
    analysis_row(analysis_id)
    objects = {obj["id"]: obj for obj in analysis_objects(analysis_id)}
    if any(object_id not in objects for object_id in body.object_ids):
        raise HTTPException(422, "object_ids 中有不属于该照片的主体")
    digest = hashlib.sha256(json.dumps({"analysis_id": analysis_id, **body.model_dump()},
                                       sort_keys=True).encode()).hexdigest()
    with connect() as db:
        try:
            db.execute("INSERT INTO generation_batches VALUES (?,?,?)", (idempotency_key, digest, analysis_id))
        except sqlite3.IntegrityError:
            existing = db.execute("SELECT digest FROM generation_batches WHERE idem_key=?",
                                  (idempotency_key,)).fetchone()
            if existing["digest"] != digest:
                raise HTTPException(409, "Idempotency-Key 已对应另一批请求")
    results = []
    for object_id in body.object_ids:
        obj = objects[object_id]
        if obj["review_status"] != "ready":
            results.append({"object_id": object_id, "state": "skipped", "reason": "主体需要审核"})
            continue
        child_key = "batch-" + hashlib.sha256((idempotency_key + ":" + object_id).encode()).hexdigest()
        try:
            result = await generate(GenerateBody(analysis_id=analysis_id, object_id=object_id,
                                    quality=body.quality, remove_background=body.remove_background),
                                    request, child_key, provider)
            results.append({"object_id": object_id, **result})
        except HTTPException as exc:
            results.append({"object_id": object_id, "state": "error", "detail": exc.detail})
    return {"analysis_id": analysis_id, "results": results}


@app.post("/v1/generations", status_code=202, dependencies=[Depends(authorize)])
async def generate(body: GenerateBody, request: Request, idempotency_key: str = Header(...), provider: Tripo = Depends(tripo)):
    if not (1 <= len(idempotency_key) <= 128):
        raise HTTPException(422, "Idempotency-Key 长度必须在 1..128")
    obj = get_object(body.analysis_id, body.object_id)
    if obj["review_status"] != "ready":
        raise HTTPException(422, "主体尚未通过审核，不能提交建模")
    if body.input_mode == "environment" and body.remove_background:
        raise HTTPException(422, "环境模式不能抠背景")
    # Preserve the digest of existing object-mode jobs across this API extension.
    digest_body = body.model_dump_json(exclude={"input_mode"} if body.input_mode == "object" else None)
    digest = hashlib.sha256(digest_body.encode()).hexdigest()
    try:
        if body.input_mode == "environment":
            with Image.open(image_path(body.analysis_id)) as image:
                prepared = prepare_environment(image)
        else:
            prepared = prepared_object(body.analysis_id, obj, body.remove_background)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    gid = uuid.uuid4().hex
    with connect() as db:
        try:
            db.execute("INSERT INTO generations (id,idem_key,digest,analysis_id,object_id,state) VALUES (?,?,?,?,?,?)",
                       (gid, idempotency_key, digest, body.analysis_id, body.object_id, "uploading"))
            db.commit()
        except sqlite3.IntegrityError:
            existing = db.execute("SELECT * FROM generations WHERE idem_key=?", (idempotency_key,)).fetchone()
            if existing["digest"] != digest:
                raise HTTPException(409, "Idempotency-Key 已对应另一请求")
            if existing["state"] != "upload_failed":
                return {"generation_id": existing["id"], "state": existing["state"], "task_id": existing["task_id"]}
            gid = existing["id"]
            claimed = db.execute("UPDATE generations SET state='uploading',error=NULL WHERE id=? AND state='upload_failed'",
                                 (gid,))
            if claimed.rowcount == 0:
                current = db.execute("SELECT state,task_id FROM generations WHERE id=?", (gid,)).fetchone()
                return {"generation_id": gid, "state": current["state"], "task_id": current["task_id"]}
    try:
        token = await provider.upload(prepared)
    except ProviderError as exc:
        with connect() as db:
            db.execute("UPDATE generations SET state=?,error=? WHERE id=?",
                       ("upload_failed", str(exc), gid))
        raise HTTPException(exc.status, f"上传失败；可用相同 Idempotency-Key 重试 generation_id={gid}") from exc
    with connect() as db:
        db.execute("UPDATE generations SET state='submitting' WHERE id=?", (gid,))
    try:
        # Once billable creation is attempted, a timeout is ambiguous. Never retry automatically.
        quality = recommended_quality(obj["category"]) if body.quality == "auto" else body.quality
        task_id = await provider.generate(token, quality)
    except ProviderError as exc:
        with connect() as db:
            db.execute("UPDATE generations SET state='submission_unknown',error=? WHERE id=?", (str(exc), gid))
        raise HTTPException(exc.status,
                            f"提交未确认；请查询 generation_id={gid}，不要换 key 重试") from exc
    with connect() as db:
        db.execute("UPDATE generations SET state='submitted',task_id=? WHERE id=?", (task_id, gid))
    return {"generation_id": gid, "state": "submitted", "task_id": task_id}


@app.get("/v1/generations/{generation_id}", dependencies=[Depends(authorize)])
async def get_generation(generation_id: str, provider: Tripo = Depends(tripo)):
    if not re.fullmatch(r"[0-9a-f]{32}", generation_id):
        raise HTTPException(404, "生成任务不存在")
    with connect() as db:
        row = db.execute("SELECT * FROM generations WHERE id=?", (generation_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "生成任务不存在")
    result = {"generation_id": row["id"], "analysis_id": row["analysis_id"],
              "object_id": row["object_id"], "state": row["state"], "task_id": row["task_id"],
              "error": row["error"]}
    if row["task_id"]:
        try:
            task = await provider.task(row["task_id"])
        except ProviderError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        result.update({"state": task.get("status", "unknown"), "progress": task.get("progress"),
                       "output": task.get("output"), "error_code": task.get("error_code"),
                       "error_message": task.get("error_message"), "credits_consumed": task.get("credits_consumed")})
        if result["state"] == "success":
            result["export_url"] = f"/v1/generations/{generation_id}/export"
        with connect() as db:
            db.execute("UPDATE generations SET state=? WHERE id=?", (result["state"], generation_id))
    return result


@app.get("/v1/generations/{generation_id}/export", dependencies=[Depends(authorize)])
async def download_export(generation_id: str, request: Request,
                          texture_size: Literal[512, 1024, 2048, 4096, 8192] = 512,
                          pivot_to_center_bottom: bool = False, format: Literal["GLB"] = "GLB",
                          filename: str | None = None,
                          provider: Tripo = Depends(tripo)):
    if pivot_to_center_bottom:
        raise HTTPException(422, "当前导出按截图保留原轴点；pivot_to_center_bottom 必须为 false")
    if not re.fullmatch(r"[0-9a-f]{32}", generation_id):
        raise HTTPException(404, "生成任务不存在")
    with connect() as db:
        row = db.execute("SELECT task_id,analysis_id,object_id FROM generations WHERE id=?",
                         (generation_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "生成任务不存在")
    if not row["task_id"]:
        raise HTTPException(409, "生成任务尚未取得 Tripo task_id")
    output = DATA_DIR / "exports" / f"{generation_id}-{texture_size}.glb"
    if not output.exists():
        try:
            task = await provider.task(row["task_id"])
            if task.get("status") != "success":
                raise HTTPException(409, "模型尚未生成成功")
            url = task.get("output", {}).get("model_url")
            if not isinstance(url, str):
                raise HTTPException(502, "Tripo 未返回 GLB 链接")
            raw = DATA_DIR / "exports" / "raw" / f"{generation_id}.glb"
            if not raw.exists():
                await download_model(request.app.state.http, url, raw)
            await asyncio.to_thread(export_glb, raw, output, texture_size=texture_size)
        except ProviderError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        except (httpx.HTTPError, ValueError, RuntimeError, OSError) as exc:
            raise HTTPException(502, f"GLB 导出失败：{str(exc)[:180]}") from exc
    obj = get_object(row["analysis_id"], row["object_id"])
    name = re.sub(r'[\\/:*?"<>|\r\n]', "_", filename or f"{obj['name']}3d模型").strip(" .")[:100] or "model"
    if name.lower().endswith(".glb"):
        name = name[:-4]
    return FileResponse(output, media_type="model/gltf-binary", filename=f"{name}.glb",
                        headers={"X-Export-Format": "GLB", "X-Texture-Size": str(texture_size),
                                 "X-Pivot-To-Center-Bottom": "false"})


@app.get("/v1/analyses/{analysis_id}/generations", dependencies=[Depends(authorize)])
def list_generations(analysis_id: str):
    analysis_row(analysis_id)
    with connect() as db:
        rows = db.execute("SELECT id,object_id,state,task_id,error FROM generations WHERE analysis_id=? ORDER BY rowid",
                          (analysis_id,)).fetchall()
    return {"analysis_id": analysis_id, "generations": [
        {"generation_id": row["id"], "object_id": row["object_id"], "state": row["state"],
         "task_id": row["task_id"], "error": row["error"]} for row in rows]}


from .universe import router as universe_router
app.include_router(universe_router)
