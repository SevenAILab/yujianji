import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import trimesh

from scripts.pipeline.batch import fingerprint, photo_path, read_encounters, run, subject_config
from scripts.pipeline.glb import _chunks, export_glb, normalize_glb, optimize_glb
from scripts.pipeline.export_stack import export_stack
from scripts.pipeline.offline_pack import build_pack
from scripts.pipeline.rarity import fallback_rarity, score_rarity


def test_glb_normalize_and_optimize(tmp_path):
    raw = tmp_path / "raw.glb"
    raw.write_bytes(trimesh.creation.box(extents=[2, 4, 1]).export(file_type="glb"))
    normalized = tmp_path / "normalized.glb"
    bbox = normalize_glb(raw, normalized)
    assert bbox == [0.5, 1.0, 0.25]
    document = json.loads(_chunks(normalized.read_bytes())[0][1])
    root = document["nodes"][document["scenes"][0]["nodes"][0]]
    assert root["matrix"][13] == pytest.approx(0.5)
    assert root["matrix"][0] == pytest.approx(0.25)
    final = tmp_path / "final.glb"
    metrics = optimize_glb(normalized, final, enabled=False)
    assert metrics["faces"] == 12 and final.read_bytes()[:4] == b"glTF"


def test_export_preserves_source_pivot(tmp_path):
    if not (Path("node_modules/.bin/gltf-transform.cmd").exists() or
            Path("node_modules/.bin/gltf-transform").exists()):
        pytest.skip("glTF Transform 未安装")
    import numpy as np
    scene = trimesh.Scene()
    transform = np.eye(4)
    transform[:3, 3] = [2, 3, 4]
    scene.add_geometry(trimesh.creation.box(), transform=transform)
    raw = tmp_path / "source.glb"
    raw.write_bytes(scene.export(file_type="glb"))
    output = tmp_path / "export.glb"
    result = export_glb(raw, output, texture_size=512)
    assert result["texture_size"] == 512
    assert result["pivot_to_center_bottom"] is False
    assert trimesh.load(raw, force="scene").bounds == pytest.approx(
        trimesh.load(output, force="scene").bounds)


def test_rarity_guard_and_thresholds():
    assert score_rarity(95, False, "普通日用品")["tier"] == "common"
    assert score_rarity(5, True, "罕见造型")["tier"] == "legendary"
    assert fallback_rarity() == {"tier": "uncommon", "score": 30, "reason": "暂未评级"}
    with pytest.raises(ValueError):
        score_rarity(101, True, "常见")
    with pytest.raises(ValueError):
        score_rarity(30, True, "出现率为 3%")


def test_batch_dry_run_keeps_contract_and_state_untouched(tmp_path, capsys):
    public = tmp_path / "public"
    photo = public / "assets" / "photos" / "fox.png"
    photo.parent.mkdir(parents=True)
    from PIL import Image
    Image.new("RGB", (512, 512), "brown").save(photo)
    source = public / "assets" / "encounters.json"
    original = [{"id": "fox", "photoUrl": "/assets/photos/fox.png", "capturedAt": "2026-09-22",
                 "label": "陶狐狸", "firstSeen": True, "quote": "原文",
                 "pipeline": {"category": "prop", "bbox": [0.1, 0.1, 0.9, 0.9]}}]
    source.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
    args = SimpleNamespace(input=str(source), public_root=str(public), state=None,
                           dry_run=True, api_url="http://127.0.0.1:8000", timeout=10,
                           poll_seconds=1, no_optimize=True)
    with httpx.Client() as client:
        run(args, client)
    assert "待提交 1 个付费任务" in capsys.readouterr().out
    assert read_encounters(source) == original
    assert not (tmp_path / ".pipeline").exists()
    assert subject_config(original[0])["category"] == "prop"
    assert len(fingerprint(photo.read_bytes(), subject_config(original[0]))) == 64
    with pytest.raises(ValueError):
        photo_path("/assets/../../secret.png", public, source)


def test_batch_end_to_end_and_resume_without_paid_api(tmp_path, monkeypatch):
    from PIL import Image
    from io import BytesIO

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    public = tmp_path / "public"
    photo = public / "assets" / "photos" / "fox.png"
    photo.parent.mkdir(parents=True)
    Image.new("RGB", (512, 512), "brown").save(photo)
    source = public / "assets" / "encounters.json"
    original = {"id": "fox", "photoUrl": "/assets/photos/fox.png", "capturedAt": "2026-09-22",
                "label": "陶狐狸", "firstSeen": True, "quote": "原文"}
    source.write_text(json.dumps([original], ensure_ascii=False), encoding="utf-8")
    subjects = tmp_path / "subjects.json"
    subjects.write_text(json.dumps({"fox": {"category": "prop", "bbox": [0, 0, 1, 1]}}), encoding="utf-8")
    glb = trimesh.creation.box(extents=[2, 4, 1]).export(file_type="glb")
    preview = BytesIO()
    Image.new("RGB", (512, 512), "brown").save(preview, "PNG")
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path == "/v1/image-to-3d":
            assert request.headers["idempotency-key"].startswith("encounter-fox-")
            return httpx.Response(202, json={"state": "submitted", "generation_id": "gen", "task_id": "task"})
        if request.url.path.startswith("/v1/analyses/") and request.url.path.endswith("/preview"):
            return httpx.Response(200, content=preview.getvalue())
        if request.url.path.startswith("/v1/analyses/"):
            return httpx.Response(200, json={"objects": [{"id": "subject"}]})
        if request.url.path == "/v1/generations/gen":
            return httpx.Response(200, json={"state": "success", "progress": 100,
                                            "credits_consumed": 30,
                                            "output": {"model_url": "https://cdn.test/fox.glb"}})
        if request.url.path == "/fox.glb":
            return httpx.Response(200, content=glb)
        raise AssertionError(request.url)

    args = SimpleNamespace(input=str(source), public_root=str(public), state=None,
                           subjects=str(subjects), dry_run=False, api_url="http://api.test",
                           timeout=10, poll_seconds=1, no_optimize=True)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        run(args, client)
        assert len([call for call in calls if call[0] == "POST"]) == 1
        output = read_encounters(source)[0]
        assert {key: output[key] for key in original} == original
        assert output["model"]["bbox"] == [0.5, 1.0, 0.25]
        assert output["model"]["glbUrl"] == "/assets/models/fox.glb"
        assert output["cutoutUrl"] == "/assets/cutouts/fox.png"
        assert output["rarity"]["reason"] == "暂未评级"
        assert (public / "assets" / "models" / "fox.glb").exists()
        archive = tmp_path / "offline.zip"
        report = build_pack(source, public, archive, ["fox"], 1)
        assert report["selected"][0]["id"] == "fox"
        from zipfile import ZipFile
        with ZipFile(archive) as packaged:
            assert "public/assets/models/fox.glb" in packaged.namelist()
        calls.clear()
        run(args, client)
        assert calls == []


def test_print_export_has_slicer_files(tmp_path):
    from zipfile import ZipFile

    models = tmp_path / "models"
    models.mkdir()
    (models / "fox.glb").write_bytes(trimesh.creation.box(extents=[0.5, 1, 0.5]).export(file_type="glb"))
    stack = tmp_path / "stack.json"
    stack.write_text(json.dumps({"baseDiameterMm": 60, "items": [{
        "id": "fox", "position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}]}),
        encoding="utf-8")
    report = export_stack(stack, models, tmp_path / "print", 30)
    assert report["items"][0]["faces"] == 12
    assert Path(report["stl"]).stat().st_size > 100
    with ZipFile(report["threeMf"]) as archive:
        assert any(name.endswith(".model") for name in archive.namelist())
