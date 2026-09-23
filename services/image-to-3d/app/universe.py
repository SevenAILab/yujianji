"""Durable photo → GLB jobs for the memory universe. One worker per DATA_DIR."""
import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from . import main as api
from .exports import download_model
from .images import MAX_UPLOAD, normalize
from .providers import ProviderError

router = APIRouter(prefix="/v1/universe", dependencies=[Depends(api.authorize)])
log = logging.getLogger(__name__)
ACTIVE = ("queued", "processing", "submitted", "queued_upstream", "running", "downloading")


def initialize():
    with api.connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS universe_jobs (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL,
            digest TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
            mode TEXT NOT NULL, state TEXT NOT NULL, generation_id TEXT,
            progress INTEGER NOT NULL DEFAULT 0, error TEXT, created REAL NOT NULL,
            UNIQUE(owner, idem))""")
        if "completed" not in {row[1] for row in db.execute("PRAGMA table_info(universe_jobs)")}:
            db.execute("ALTER TABLE universe_jobs ADD COLUMN completed REAL")


def owner_key(x_universe_id: str = Header(...)):
    # Random browser capability, independent of Tripo/service secrets. Never put it in URLs.
    if not re.fullmatch(r"[0-9a-f]{64}", x_universe_id):
        raise HTTPException(401, "记忆空间标识无效，请重新打开页面")
    return hashlib.sha256(x_universe_id.encode()).hexdigest()


def model_path(job_id):
    return api.DATA_DIR / "universe" / "models" / f"{job_id}.glb"


def photo_path(job_id):
    return api.DATA_DIR / "universe" / "photos" / f"{job_id}.image"


def public_job(row):
    result = {key: row[key] for key in ("id", "name", "state", "generation_id", "progress", "error", "created", "completed")}
    if row["state"] == "ready":
        result["model_url"] = f"models/{row['id']}"
    return result


def owned_job(job_id, owner):
    with api.connect() as db:
        row = db.execute("SELECT * FROM universe_jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
    if row is None:
        raise HTTPException(404, "记忆不存在")
    return row


def update(job_id, **fields):
    allowed = {"state", "generation_id", "progress", "error", "completed"}
    assert fields.keys() <= allowed
    with api.connect() as db:
        db.execute("UPDATE universe_jobs SET " + ",".join(f"{k}=?" for k in fields) + " WHERE id=?",
                   (*fields.values(), job_id))


@router.post("/jobs", status_code=202)
async def submit(request: Request, file: UploadFile = File(...),
                 name: str = Form("新的记忆", min_length=1, max_length=100),
                 category: Literal["character", "creature", "furniture", "prop", "weapon", "vehicle", "building", "plant", "other"] = Form("prop"),
                 input_mode: Literal["object", "environment"] = Form("object"),
                 idempotency_key: str = Header(...), owner: str = Depends(owner_key)):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", idempotency_key):
        raise HTTPException(422, "上传标识无效")
    raw = await file.read(MAX_UPLOAD + 1)
    try:
        await asyncio.to_thread(normalize, raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    digest = hashlib.sha256(raw + json.dumps([name, category, input_mode]).encode()).hexdigest()
    with api.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM universe_jobs WHERE owner=? AND idem=?", (owner, idempotency_key)).fetchone()
        if existing:
            if existing["digest"] != digest:
                raise HTTPException(409, "该上传标识已用于另一张照片")
            return public_job(existing)
        if not os.getenv("TRIPO_API_KEY"):
            raise HTTPException(503, "照片建模服务尚未配置")
        if not getattr(request.app.state, "universe_worker", None):
            raise HTTPException(503, "照片建模服务尚未启动")
        # Persistent bounds also protect deployments without the Next.js gateway.
        placeholders = ",".join("?" for _ in ACTIVE)
        pending = db.execute(f"SELECT count(*) FROM universe_jobs WHERE owner=? AND state IN ({placeholders})", (owner, *ACTIVE)).fetchone()[0]
        daily = db.execute("SELECT count(*) FROM universe_jobs WHERE created>?", (time.time() - 86400,)).fetchone()[0]
        if pending >= 3 or daily >= int(os.getenv("UNIVERSE_DAILY_LIMIT", "20")):
            raise HTTPException(429, "生成队列或今日额度已满，请稍后再试")
        job_id = uuid.uuid4().hex
        path = photo_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        db.execute("INSERT INTO universe_jobs (id,owner,idem,digest,name,category,mode,state,created) VALUES (?,?,?,?,?,?,?,?,?)",
                   (job_id, owner, idempotency_key, digest, name, category, input_mode, "queued", time.time()))
    request.app.state.universe_wake.set()
    return public_job(owned_job(job_id, owner))


@router.get("/jobs")
def jobs(owner: str = Depends(owner_key)):
    with api.connect() as db:
        rows = db.execute("SELECT * FROM universe_jobs WHERE owner=? ORDER BY created,id", (owner,)).fetchall()
    return {"jobs": [public_job(row) for row in rows]}


@router.get("/jobs/{job_id}")
def job(job_id: str, owner: str = Depends(owner_key)):
    return public_job(owned_job(job_id, owner))


@router.post("/jobs/{job_id}/resume", status_code=202)
def resume(job_id: str, request: Request, owner: str = Depends(owner_key)):
    row = owned_job(job_id, owner)
    # Resume polling/downloading only; never create another paid generation.
    if row["state"] not in ("paused", "download_failed") or not row["generation_id"]:
        raise HTTPException(409, "该任务需要人工核对，不能自动重新生成")
    update(job_id, state="submitted", error=None)
    request.app.state.universe_wake.set()
    return public_job(owned_job(job_id, owner))


@router.get("/models/{job_id}")
def model(job_id: str, owner: str = Depends(owner_key)):
    row = owned_job(job_id, owner)
    if row["state"] != "ready" or not model_path(job_id).is_file():
        raise HTTPException(409, "模型尚未就绪")
    return FileResponse(model_path(job_id), media_type="model/gltf-binary",
                        headers={"Cache-Control": "private, no-store"})


async def process(row, request):
    jid = row["id"]
    provider = api.tripo(request)
    gid = row["generation_id"]
    if not gid:
        update(jid, state="processing", error=None)
        # A single durable job id drives both the local analysis and billable idempotency.
        raw = photo_path(jid).read_bytes()
        analysis = await api.create_analysis(request, raw, jid, use_vision=False)
        subject = analysis["objects"][0] if analysis["objects"] else api.add_subject(jid, api.Subject(
            name=row["name"], category=row["category"], bbox=(0, 0, 1, 1)))
        key = "universe-" + jid
        with api.connect() as db:
            old = db.execute("SELECT * FROM generations WHERE idem_key=?", (key,)).fetchone()
        if old and not old["task_id"] and old["state"] in ("submitting", "submission_unknown"):
            update(jid, state="submission_unknown", generation_id=old["id"], error="提交结果待核对，请勿重复上传；请联系管理员核对 Tripo 任务")
            return
        if old and old["state"] == "uploading":
            # Exclusive worker means this is an interrupted pre-submission upload.
            with api.connect() as db:
                db.execute("UPDATE generations SET state='upload_failed' WHERE id=?", (old["id"],))
        try:
            generated = await api.generate(api.GenerateBody(analysis_id=jid, object_id=subject["id"],
                quality="standard", input_mode=row["mode"]), request, key, provider)
        except HTTPException:
            with api.connect() as db:
                old = db.execute("SELECT * FROM generations WHERE idem_key=?", (key,)).fetchone()
            if old:
                update(jid, state=old["state"], generation_id=old["id"], error="生成提交未完成，请联系管理员核对任务；不要重复上传")
                return
            raise
        gid = generated["generation_id"]
        update(jid, generation_id=gid, state="submitted")
    deadline = time.monotonic() + 1800
    failures = 0
    while time.monotonic() < deadline:
        try:
            result = await api.get_generation(gid, provider)
            failures = 0
        except HTTPException:
            failures += 1
            if failures >= 5:
                update(jid, state="paused", error="网络暂时不可用，可继续查询；不会重新扣费")
                return
            await asyncio.sleep(10)
            continue
        state = result["state"]
        if state == "success":
            update(jid, state="downloading", progress=100)
            try:
                url = (result.get("output") or {}).get("model_url")
                if not isinstance(url, str):
                    raise ValueError("模型地址缺失")
                if not model_path(jid).exists():
                    await download_model(request.app.state.http, url, model_path(jid))
            except Exception:
                update(jid, state="download_failed", error="模型已生成，下载暂时失败；可继续下载，不会重新生成")
                return
            update(jid, state="ready", error=None, completed=time.time())
            return
        if state in ("failed", "cancelled", "submission_unknown", "upload_failed"):
            update(jid, state=state, error="生成未完成，请联系管理员核对；不要重复上传")
            return
        progress = result.get("progress")
        update(jid, state="queued_upstream" if state == "queued" else "running",
               progress=max(0, min(99, int(progress or 0))))
        await asyncio.sleep(5)
    update(jid, state="paused", error="模型仍在生成，可稍后继续查询；不会重新扣费")


async def worker(app):
    request = Request({"type": "http", "app": app})
    while True:
        app.state.universe_wake.clear()
        with api.connect() as db:
            placeholders = ",".join("?" for _ in ACTIVE)
            row = db.execute(f"SELECT * FROM universe_jobs WHERE state IN ({placeholders}) ORDER BY created,id LIMIT 1", ACTIVE).fetchone()
        if row:
            try:
                await process(row, request)
            except Exception:
                log.exception("Memory job failed: %s", row["id"])
                update(row["id"], state="paused" if row["generation_id"] else "error",
                       error="建模任务暂时中断，请联系管理员核对任务")
        else:
            await app.state.universe_wake.wait()


async def start(app):
    initialize()
    if os.getenv("UNIVERSE_WORKER", "1") != "1":
        app.state.universe_worker = None
        return
    # Hold an OS lock for the full worker lifetime, including across awaits.
    # Prevent duplicate submissions if uvicorn is accidentally started with >1 worker.
    lock = (api.DATA_DIR / "universe-worker.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            lock.write(b"0"); lock.flush(); lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        raise RuntimeError("记忆宇宙服务请使用单 worker；该数据目录已有工作进程") from None
    app.state.universe_lock = lock
    app.state.universe_wake = asyncio.Event()
    app.state.universe_worker = asyncio.create_task(worker(app))


async def stop(app):
    task = getattr(app.state, "universe_worker", None)
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        app.state.universe_lock.close()
