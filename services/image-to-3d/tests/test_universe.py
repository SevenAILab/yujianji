import asyncio
import hashlib
import time
from io import BytesIO

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from PIL import Image

from app import main, universe


OWNER = "a" * 64
HEADERS = {"X-Universe-ID": OWNER, "Idempotency-Key": "same-photo-1234"}


def photo():
    buf = BytesIO()
    Image.new("RGB", (300, 300), "red").save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.setenv("TRIPO_API_KEY", "test-only")
    monkeypatch.setenv("UNIVERSE_WORKER", "0")
    monkeypatch.delenv("SERVICE_API_KEY", raising=False)
    with TestClient(main.app) as client:
        # Disable automatic execution; drive the worker with a fake upstream explicitly.
        main.app.state.universe_worker = True
        main.app.state.universe_wake = asyncio.Event()
        yield client
        main.app.state.universe_worker = None


def upload(client, headers=HEADERS):
    return client.post("/v1/universe/jobs", headers=headers,
                       files={"file": ("memory.png", photo(), "image/png")}, data={"name": "小狐狸"})


def test_upload_idempotency_owner_and_invalid_photo(client):
    first = upload(client)
    assert first.status_code == 202
    jid = first.json()["id"]
    assert upload(client).json()["id"] == jid
    changed = client.post("/v1/universe/jobs", headers=HEADERS,
                         files={"file": ("memory.png", photo(), "image/png")}, data={"name": "另一张照片"})
    assert changed.status_code == 409
    assert client.get("/v1/universe/jobs", headers=HEADERS).json()["jobs"][0]["id"] == jid
    other = {"X-Universe-ID": "b" * 64}
    assert client.get("/v1/universe/jobs", headers=other).json() == {"jobs": []}
    assert client.get(f"/v1/universe/jobs/{jid}", headers=other).status_code == 404
    assert client.get(f"/v1/universe/models/{jid}", headers=other).status_code == 404
    assert client.get(f"/v1/universe/models/{jid}", headers=HEADERS).status_code == 409
    bad = client.post("/v1/universe/jobs", headers=HEADERS, files={"file": ("bad.png", b"not an image", "image/png")})
    assert bad.status_code == 422


def test_persistent_queue_limits(client, monkeypatch):
    monkeypatch.setenv("UNIVERSE_DAILY_LIMIT", "2")
    assert upload(client).status_code == 202
    assert upload(client, {**HEADERS, "Idempotency-Key": "different-1234"}).status_code == 202
    assert upload(client, {**HEADERS, "Idempotency-Key": "different-5678"}).status_code == 429
    assert upload(client).status_code == 202  # Retry is not another billed job/quota slot.


def test_generated_glb_is_published_once_and_download_resume_never_regenerates(client, monkeypatch):
    jid = upload(client).json()["id"]
    calls = []

    class FakeProvider:
        async def upload(self, data):
            calls.append("upload")
            return "file-test"

        async def generate(self, token, quality):
            calls.append("generate")
            return "task-test"

        async def task(self, task_id):
            return {"status": "success", "progress": 100, "output": {"model_url": "https://cdn.tripo3d.ai/result.glb"}}

    monkeypatch.setattr(main, "tripo", lambda request: FakeProvider())
    attempts = []

    async def download(http, url, destination):
        attempts.append(url)
        if len(attempts) == 1:
            raise OSError("interrupted")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"glTF-test-model")

    monkeypatch.setattr(universe, "download_model", download)
    owner = hashlib.sha256(OWNER.encode()).hexdigest()
    request = Request({"type": "http", "app": main.app})
    asyncio.run(universe.process(universe.owned_job(jid, owner), request))
    assert universe.owned_job(jid, owner)["state"] == "download_failed"
    assert client.post(f"/v1/universe/jobs/{jid}/resume", headers=HEADERS).status_code == 202
    asyncio.run(universe.process(universe.owned_job(jid, owner), request))
    assert calls == ["upload", "generate"]
    result = client.get(f"/v1/universe/jobs/{jid}", headers=HEADERS).json()
    assert result["state"] == "ready" and result["model_url"] == f"models/{jid}"
    assert client.get(f"/v1/universe/models/{jid}", headers=HEADERS).content == b"glTF-test-model"
    assert client.post(f"/v1/universe/jobs/{jid}/resume", headers=HEADERS).status_code == 409


def test_restart_does_not_repeat_ambiguous_submission(client, monkeypatch):
    jid = upload(client).json()["id"]
    request = Request({"type": "http", "app": main.app})
    analysis = asyncio.run(main.create_analysis(request, photo(), jid, use_vision=False))
    subject = main.add_subject(jid, main.Subject(name="小狐狸", category="prop", bbox=(0, 0, 1, 1)))
    with main.connect() as db:
        db.execute("INSERT INTO generations (id,idem_key,digest,analysis_id,object_id,state) VALUES (?,?,?,?,?,?)",
                   ("c" * 32, "universe-" + jid, "digest", jid, subject["id"], "submitting"))
    monkeypatch.setattr(main, "tripo", lambda request: object())
    owner = hashlib.sha256(OWNER.encode()).hexdigest()
    asyncio.run(universe.process(universe.owned_job(jid, owner), request))
    row = universe.owned_job(jid, owner)
    assert row["state"] == "submission_unknown"
    assert row["generation_id"] == "c" * 32
