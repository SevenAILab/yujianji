from io import BytesIO
import json
import sqlite3

from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.providers import Tripo
from app.providers import ProviderError


def test_flow_and_idempotency(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("TRIPO_API_KEY", "test")
    calls = []

    class FakeTripo:
        async def upload(self, image):
            with Image.open(BytesIO(image)) as prepared:
                assert prepared.size[0] == prepared.size[1]
            calls.append("upload")
            return "file_test"

        async def generate(self, token, quality):
            calls.append((token, quality))
            return "task_test"

        async def task(self, task_id):
            return {"status": "success", "progress": 100, "output": {"model_url": "https://example.test/model.glb"}}

    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            source = BytesIO()
            Image.new("RGB", (800, 600), "red").save(source, "JPEG")
            analysis = client.post("/v1/analyses", files={"file": ("sample.jpg", source.getvalue(), "image/jpeg")})
            assert analysis.status_code == 200
            aid = analysis.json()["analysis_id"]
            assert analysis.json()["vision_status"] == "not_configured"
            assert analysis.json()["objects"] == []
            obj = client.post(f"/v1/analyses/{aid}/objects", json={
                "name": "红色椅子", "category": "furniture", "bbox": [.1, .1, .9, .9]})
            assert obj.status_code == 200
            oid = obj.json()["id"]
            preview = client.get(f"/v1/analyses/{aid}/objects/{oid}/preview")
            assert preview.status_code == 200 and preview.headers["content-type"] == "image/png"
            body = {"analysis_id": aid, "object_id": oid, "quality": "high"}
            first = client.post("/v1/generations", json=body, headers={"Idempotency-Key": "one"})
            assert first.status_code == 202
            again = client.post("/v1/generations", json=body, headers={"Idempotency-Key": "one"})
            assert again.json() == first.json()
            assert calls == ["upload", ("file_test", "high")]
            conflict = client.post("/v1/generations", json={**body, "quality": "standard"},
                                   headers={"Idempotency-Key": "one"})
            assert conflict.status_code == 409
            result = client.get(f"/v1/generations/{first.json()['generation_id']}")
            assert result.json()["output"]["model_url"].endswith("model.glb")
    finally:
        main.app.dependency_overrides.clear()


def test_image_input_rejects_invalid():
    from app.images import normalize
    import pytest
    with pytest.raises(ValueError):
        normalize(b"not an image")


def test_environment_preparation_keeps_room_aspect_ratio():
    from app.images import prepare_environment
    scene = Image.new("RGB", (1600, 900), "red")
    with Image.open(BytesIO(prepare_environment(scene))) as prepared:
        assert prepared.size == (1536, 864)


def test_category_quality_defaults():
    assert main.recommended_quality("creature") == "high"
    assert main.recommended_quality("prop") == "standard"


def test_direct_endpoint_for_another_service(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("TRIPO_API_KEY", "test")
    calls = []

    class FakeTripo:
        async def upload(self, image):
            calls.append("upload")
            return "file_direct"

        async def generate(self, token, quality):
            calls.append((token, quality))
            return "task_direct"

    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            buf = BytesIO()
            Image.new("RGB", (512, 512), "blue").save(buf, "PNG")
            files = {"file": ("image.png", buf.getvalue(), "image/png")}
            headers = {"Idempotency-Key": "external-order-42"}
            missing = client.post("/v1/image-to-3d", files=files, headers=headers)
            assert missing.status_code == 422 and not calls
            form = {"category": "creature", "target_name": "蓝色生物", "bbox": "0,0,1,1"}
            first = client.post("/v1/image-to-3d", files=files, data=form, headers=headers)
            assert first.status_code == 202
            again = client.post("/v1/image-to-3d", files=files, data=form, headers=headers)
            assert again.json() == first.json()
            assert calls == ["upload", ("file_direct", "high")]
    finally:
        main.app.dependency_overrides.clear()


def test_direct_endpoint_requires_choice_for_multiple_objects(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setenv("TRIPO_API_KEY", "test")

    async def fake_recognize(*args):
        return [{"name": name, "category": "prop", "bbox": box, "confidence": .9,
                 "occluded": False, "description": name}
                for name, box in [("杯子", [.0, .0, .5, 1.]), ("瓶子", [.5, .0, 1., 1.])]]

    class FakeTripo:
        async def upload(self, image):
            return "file_choice"

        async def generate(self, token, quality):
            return "task_choice"

    monkeypatch.setattr(main, "recognize", fake_recognize)
    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            buf = BytesIO()
            Image.new("RGB", (600, 600), "white").save(buf, "PNG")
            files = {"file": ("objects.png", buf.getvalue(), "image/png")}
            headers = {"Idempotency-Key": "choose-one"}
            ambiguous = client.post("/v1/image-to-3d", files=files, headers=headers)
            assert ambiguous.status_code == 409
            assert len(ambiguous.json()["detail"]["objects"]) == 2
            selected = client.post("/v1/image-to-3d", files=files, data={"target_index": "1"}, headers=headers)
            assert selected.status_code == 202
            assert selected.json()["task_id"] == "task_choice"
    finally:
        main.app.dependency_overrides.clear()


def test_tagged_multi_object_crops_and_batch_resume(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setenv("TRIPO_API_KEY", "test")
    uploads = []

    async def fake_recognize(*args):
        return [
            {"name": "红椅", "category": "furniture", "bbox": [0, 0, .48, 1],
             "confidence": .95, "occluded": False, "description": "红色椅子", "tags": ["木质", "座椅"]},
            {"name": "蓝瓶", "category": "prop", "bbox": [.52, 0, 1, 1],
             "confidence": .5, "occluded": True, "description": "蓝色瓶子", "tags": ["玻璃", "容器"]},
        ]

    class FakeTripo:
        async def upload(self, image):
            with Image.open(BytesIO(image)) as crop:
                uploads.append(crop.getpixel((crop.width // 2, crop.height // 2)))
            return "file_test"

        async def generate(self, token, quality):
            return f"task_{len(uploads)}"

    monkeypatch.setattr(main, "recognize", fake_recognize)
    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            image = Image.new("RGB", (800, 400), "red")
            image.paste("blue", (400, 0, 800, 400))
            buf = BytesIO()
            image.save(buf, "PNG")
            analysis = client.post("/v1/analyses", files={"file": ("room.png", buf.getvalue(), "image/png")}).json()
            aid = analysis["analysis_id"]
            first, second = analysis["objects"]
            assert first["tags"] == ["木质", "座椅"]
            assert second["review_status"] == "needs_review"
            found = client.get("/v1/objects", params={"category": "furniture", "tag": "木质"}).json()
            assert found["total"] == 1 and found["objects"][0]["id"] == first["id"]
            crop = client.get(f"/v1/analyses/{aid}/objects/{first['id']}/preview")
            assert crop.status_code == 200
            assert list((tmp_path / "cutouts").glob("*.png"))
            body = {"object_ids": [first["id"], second["id"]]}
            headers = {"Idempotency-Key": "room-batch-1"}
            submitted = client.post(f"/v1/analyses/{aid}/generations", json=body, headers=headers)
            assert submitted.status_code == 202
            assert [item["state"] for item in submitted.json()["results"]] == ["submitted", "skipped"]
            assert uploads == [(255, 0, 0)]
            edited = client.patch(f"/v1/analyses/{aid}/objects/{second['id']}",
                                  json={"review_status": "ready"})
            assert edited.status_code == 200
            resumed = client.post(f"/v1/analyses/{aid}/generations", json=body, headers=headers)
            assert [item["state"] for item in resumed.json()["results"]] == ["submitted", "submitted"]
            assert uploads == [(255, 0, 0), (0, 0, 255)]
            jobs = client.get(f"/v1/analyses/{aid}/generations").json()["generations"]
            assert {job["object_id"] for job in jobs} == {first["id"], second["id"]}
            conflict = client.post(f"/v1/analyses/{aid}/generations",
                                   json={"object_ids": [first["id"]]}, headers=headers)
            assert conflict.status_code == 409
    finally:
        main.app.dependency_overrides.clear()


def test_existing_analyses_are_indexed_without_losing_object_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    with sqlite3.connect(main.DB) as db:
        db.execute("CREATE TABLE analyses (id TEXT PRIMARY KEY, objects TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, vision_status TEXT NOT NULL)")
        old = [{"id": "legacy-object", "name": "旧木杯", "category": "prop",
                "bbox": [0, 0, 1, 1], "confidence": 1, "occluded": False, "description": ""}]
        db.execute("INSERT INTO analyses VALUES (?,?,?,?,?)", ("legacy", json.dumps(old), 512, 512, "ok"))
    with TestClient(main.app) as client:
        response = client.get("/v1/analyses/legacy")
        assert response.status_code == 200
        obj = response.json()["objects"][0]
        assert obj["id"] == "legacy-object" and obj["tags"] == []
        assert client.get("/v1/objects", params={"category": "prop"}).json()["total"] == 1


def test_upload_failure_reuses_same_idempotency_key(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.setenv("TRIPO_API_KEY", "test")
    attempts = []

    class FakeTripo:
        async def upload(self, image):
            attempts.append("upload")
            if len(attempts) == 1:
                raise ProviderError("temporary upload failure", 503)
            return "token"

        async def generate(self, token, quality):
            attempts.append("generate")
            return "task_after_retry"

    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            buf = BytesIO()
            Image.new("RGB", (512, 512), "white").save(buf, "PNG")
            analysis = client.post("/v1/analyses", files={"file": ("x.png", buf.getvalue(), "image/png")}).json()
            obj = client.post(f"/v1/analyses/{analysis['analysis_id']}/objects", json={
                "name": "白杯", "category": "prop", "bbox": [0, 0, 1, 1]}).json()
            body = {"analysis_id": analysis["analysis_id"], "object_id": obj["id"]}
            headers = {"Idempotency-Key": "retry-upload-only"}
            failed = client.post("/v1/generations", json=body, headers=headers)
            assert failed.status_code == 503
            recovered = client.post("/v1/generations", json=body, headers=headers)
            assert recovered.status_code == 202 and recovered.json()["task_id"] == "task_after_retry"
            assert attempts == ["upload", "upload", "generate"]
    finally:
        main.app.dependency_overrides.clear()


def test_export_defaults_match_glb_512_and_original_pivot(tmp_path, monkeypatch):
    import shutil
    import trimesh

    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "DB", tmp_path / "jobs.sqlite3")
    monkeypatch.setenv("TRIPO_API_KEY", "test")
    raw_glb = trimesh.creation.box().export(file_type="glb")
    options = []

    class FakeTripo:
        async def upload(self, image):
            return "file"

        async def generate(self, token, quality):
            return "task"

        async def task(self, task_id):
            return {"status": "success", "output": {
                "model_url": "https://tripo-data.rg1.data.tripo3d.com/model.glb"}}

    async def fake_download(client, url, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw_glb)

    def fake_export(source, destination, *, texture_size):
        options.append(texture_size)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    monkeypatch.setattr(main, "download_model", fake_download)
    monkeypatch.setattr(main, "export_glb", fake_export)
    main.app.dependency_overrides[main.tripo] = FakeTripo
    try:
        with TestClient(main.app) as client:
            buf = BytesIO()
            Image.new("RGB", (512, 512), "white").save(buf, "PNG")
            analysis = client.post("/v1/analyses", files={"file": ("x.png", buf.getvalue(), "image/png")}).json()
            obj = client.post(f"/v1/analyses/{analysis['analysis_id']}/objects", json={
                "name": "白色兰花", "category": "plant", "bbox": [0, 0, 1, 1]}).json()
            job = client.post("/v1/generations", json={"analysis_id": analysis["analysis_id"],
                               "object_id": obj["id"]}, headers={"Idempotency-Key": "orchid"}).json()
            response = client.get(f"/v1/generations/{job['generation_id']}/export")
            assert response.status_code == 200 and response.content == raw_glb
            assert response.headers["x-export-format"] == "GLB"
            assert response.headers["x-texture-size"] == "512"
            assert response.headers["x-pivot-to-center-bottom"] == "false"
            assert "glb" in response.headers["content-disposition"]
            assert options == [512]
            assert client.get(f"/v1/generations/{job['generation_id']}/export",
                              params={"pivot_to_center_bottom": "true"}).status_code == 422
    finally:
        main.app.dependency_overrides.clear()
