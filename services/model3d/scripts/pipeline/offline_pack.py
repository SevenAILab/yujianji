"""Validate and bundle selected Encounter assets for an offline demo."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import trimesh

from scripts.pipeline.batch import read_encounters
from scripts.pipeline.glb import _chunks


def asset_file(public_root: Path, url: str) -> Path:
    if not isinstance(url, str) or not re.fullmatch(r"/assets/[a-zA-Z0-9_./-]+", url):
        raise ValueError(f"不是站内资产 URL: {url}")
    path = (public_root / url.lstrip("/")).resolve()
    if not path.is_relative_to(public_root.resolve()) or not path.is_file():
        raise ValueError(f"资产不存在或越界: {url}")
    return path


def build_pack(input_path: Path, public_root: Path, destination: Path,
               selected_ids: list[str] | None = None, min_ready: int = 8) -> dict:
    records = read_encounters(input_path)
    chosen = [record for record in records if selected_ids is None or record["id"] in selected_ids]
    if selected_ids is not None and {record["id"] for record in chosen} != set(selected_ids):
        raise ValueError("精选 id 在 encounters.json 中不存在")
    if len(chosen) < min_ready:
        raise ValueError(f"只找到 {len(chosen)} 条，少于要求的 {min_ready} 条")
    files = {}
    report = {"selected": [], "totalBytes": 0}
    for record in chosen:
        model = record.get("model")
        if not isinstance(model, dict) or not isinstance(model.get("bbox"), list) or len(model["bbox"]) != 3:
            raise ValueError(f"{record['id']} 缺少 model.bbox")
        if not all(isinstance(v, (int, float)) and 0 < v <= 1.01 for v in model["bbox"]):
            raise ValueError(f"{record['id']} 的 model.bbox 无效")
        if not isinstance(record.get("rarity"), dict) or record["rarity"].get("tier") not in {
            "common", "uncommon", "rare", "epic", "legendary"}:
            raise ValueError(f"{record['id']} 缺少合法 rarity")
        urls = [record["photoUrl"], record.get("cutoutUrl"), model.get("glbUrl")]
        if not all(urls):
            raise ValueError(f"{record['id']} 缺少照片、cutout 或 GLB")
        paths = [asset_file(public_root, url) for url in urls]
        glb = paths[-1]
        _chunks(glb.read_bytes())
        scene = trimesh.load(glb, force="scene", process=False)
        faces = sum(len(mesh.faces) for mesh in scene.geometry.values())
        if not faces:
            raise ValueError(f"{record['id']} 的 GLB 无三角面")
        for url, path in zip(urls, paths):
            files[path] = Path("public") / url.lstrip("/")
        report["selected"].append({"id": record["id"], "modelBytes": glb.stat().st_size,
                                   "modelFaces": faces})
    stack = public_root / "assets" / "stack.json"
    if stack.is_file():
        files[stack.resolve()] = Path("public/assets/stack.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        encounter_data = (json.dumps(chosen, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        archive.writestr("public/assets/encounters.json", encounter_data)
        report["totalBytes"] += len(encounter_data)
        for source, name in files.items():
            archive.write(source, name.as_posix())
            report["totalBytes"] += source.stat().st_size
        archive.writestr("asset-report.json", json.dumps(report, ensure_ascii=False, indent=2))
    report["archive"] = str(destination)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="public/assets/encounters.json")
    parser.add_argument("--public-root", default="public")
    parser.add_argument("--output", default="output/encounter-offline-assets.zip")
    parser.add_argument("--ids", nargs="*")
    parser.add_argument("--min-ready", type=int, default=8)
    args = parser.parse_args()
    report = build_pack(Path(args.input), Path(args.public_root), Path(args.output),
                        args.ids, args.min_ready)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
