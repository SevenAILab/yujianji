"""Convert A's normalized Y-up stack.json to slicer-readable 3MF and STL.

Expected: {"items":[{"id":"fox","position":[0,0,0],
"quaternion":[0,0,0,1],"scale":[1,1,1]}],"baseDiameterMm":80}
"""
import argparse
import json
from pathlib import Path

import numpy as np
import trimesh


def _vector(value, size, name):
    if not isinstance(value, list) or len(value) != size or not all(isinstance(x, (int, float)) for x in value):
        raise ValueError(f"{name} 必须为 {size} 个数字")
    vector = np.asarray(value, dtype=float)
    if not np.isfinite(vector).all():
        raise ValueError(f"{name} 包含非有限数")
    return vector


def export_stack(stack_path: Path, models_dir: Path, output_dir: Path, unit_mm: float = 40) -> dict:
    document = json.loads(stack_path.read_text(encoding="utf-8"))
    items = document.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("stack.json 需要非空 items 数组")
    diameter = float(document.get("baseDiameterMm", 80))
    thickness = float(document.get("baseThicknessMm", 3))
    if not 10 <= diameter <= 300 or not 1 <= thickness <= 20 or not 1 <= unit_mm <= 500:
        raise ValueError("打印尺寸超出合理范围")
    # Three.js Y-up -> slicer Z-up, preserve right-handed coordinates.
    to_print = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
    base = trimesh.creation.cylinder(radius=diameter / 2, height=thickness, sections=96)
    base.apply_translation([0, 0, thickness / 2])
    meshes = [base]
    report = {"items": [], "baseDiameterMm": diameter, "unitMm": unit_mm}
    seen = set()
    for item in items:
        identity = item.get("id")
        if not isinstance(identity, str) or not identity.isascii() or not identity.replace("-", "").replace("_", "").isalnum():
            raise ValueError("stack item id 无效")
        if identity in seen:
            raise ValueError(f"重复 stack item id: {identity}")
        seen.add(identity)
        source = models_dir / f"{identity}.glb"
        if not source.is_file():
            raise FileNotFoundError(source)
        position = _vector(item.get("position", [0, 0, 0]), 3, "position")
        quaternion = _vector(item.get("quaternion", [0, 0, 0, 1]), 4, "quaternion")
        scale = item.get("scale", [1, 1, 1])
        scale = [scale] * 3 if isinstance(scale, (int, float)) else scale
        scale = _vector(scale, 3, "scale")
        if np.linalg.norm(quaternion) < 1e-8 or (scale <= 0).any():
            raise ValueError(f"{identity} 的旋转或缩放无效")
        quaternion /= np.linalg.norm(quaternion)
        rotation = trimesh.transformations.quaternion_matrix(
            [quaternion[3], quaternion[0], quaternion[1], quaternion[2]])
        local = np.eye(4)
        local[:3, :3] = rotation[:3, :3] @ np.diag(scale * unit_mm)
        local[:3, 3] = position * unit_mm
        source_scene = trimesh.load(source, force="scene", process=False)
        if not source_scene.geometry:
            raise ValueError(f"{identity} 没有几何体")
        if source_scene.extents.max() > 1.05 or source_scene.extents.max() < 0.5:
            raise ValueError(f"{identity} 的 GLB 未按最长边 1 归一化")
        count = 0
        open_shells = 0
        for node_name in source_scene.graph.nodes_geometry:
            node_transform, geometry_name = source_scene.graph[node_name]
            mesh = source_scene.geometry[geometry_name].copy()
            mesh.apply_transform(to_print @ local @ node_transform)
            mesh.apply_translation([0, 0, thickness])
            if len(mesh.faces):
                meshes.append(mesh)
                count += len(mesh.faces)
                open_shells += int(not mesh.is_watertight)
        if not count:
            raise ValueError(f"{identity} 没有三角面")
        report["items"].append({"id": identity, "faces": count, "openShells": open_shells})
    output_dir.mkdir(parents=True, exist_ok=True)
    combined = trimesh.util.concatenate(meshes)
    stl = output_dir / "encounter-stack.stl"
    model_3mf = output_dir / "encounter-stack.3mf"
    combined.export(stl)
    scene = trimesh.Scene()
    for index, mesh in enumerate(meshes):
        scene.add_geometry(mesh, node_name=f"part-{index}")
    scene.export(model_3mf)
    report["stl"] = str(stl)
    report["threeMf"] = str(model_3mf)
    (output_dir / "print-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", default="public/assets/stack.json")
    parser.add_argument("--models", default="public/assets/models")
    parser.add_argument("--output", default="output/print")
    parser.add_argument("--unit-mm", type=float, default=40)
    args = parser.parse_args()
    report = export_stack(Path(args.stack), Path(args.models), Path(args.output), args.unit_mm)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
