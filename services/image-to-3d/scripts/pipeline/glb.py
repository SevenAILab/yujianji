"""Validate GLB and add a root transform without touching meshes or PBR data."""
import json
import os
import subprocess
import struct
import uuid
from pathlib import Path

import trimesh


def _chunks(raw: bytes):
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise ValueError("不是 GLB 文件")
    magic, version, total = struct.unpack_from("<4sII", raw)
    if version != 2 or total != len(raw):
        raise ValueError("GLB 版本或长度无效")
    offset, parts = 12, []
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise ValueError("GLB chunk 不完整")
        length, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        if offset + length > len(raw):
            raise ValueError("GLB chunk 越界")
        parts.append((kind, raw[offset:offset + length]))
        offset += length
    if not parts or parts[0][0] != b"JSON":
        raise ValueError("GLB 缺少 JSON chunk")
    return parts


def normalize_glb(source: Path, destination: Path, yaw_degrees: float = 0) -> list[float]:
    """Y-up, ground at Y=0, center X/Z, longest side=1. Return final bbox."""
    import numpy as np

    raw = source.read_bytes()
    parts = _chunks(raw)
    document = json.loads(parts[0][1])
    if document.get("asset", {}).get("version") != "2.0":
        raise ValueError("仅支持 glTF 2.0")
    scene_index = document.get("scene", 0)
    scenes = document.get("scenes", [])
    if not isinstance(scene_index, int) or not 0 <= scene_index < len(scenes):
        raise ValueError("GLB 缺少默认 scene")
    roots = list(scenes[scene_index].get("nodes", []))
    if not roots:
        raise ValueError("GLB 场景为空")
    scene = trimesh.load(source, force="scene", process=False)
    if not scene.geometry or scene.bounds is None:
        raise ValueError("GLB 没有有效几何体")
    vertices = sum(len(mesh.vertices) for mesh in scene.geometry.values())
    faces = sum(len(mesh.faces) for mesh in scene.geometry.values())
    if not vertices or not faces:
        raise ValueError("GLB 没有非空网格")
    import math
    rad = math.radians(yaw_degrees)
    rotation = np.array([[math.cos(rad), 0, math.sin(rad)],
                         [0, 1, 0], [-math.sin(rad), 0, math.cos(rad)]])
    lower, upper = np.full(3, np.inf), np.full(3, -np.inf)
    for node_name in scene.graph.nodes_geometry:
        node_transform, geometry_name = scene.graph[node_name]
        mesh = scene.geometry[geometry_name]
        vertices = np.asarray(mesh.vertices, dtype=float)
        if len(vertices) == 0:
            continue
        turned = (vertices @ node_transform[:3, :3].T + node_transform[:3, 3]) @ rotation.T
        lower = np.minimum(lower, turned.min(axis=0))
        upper = np.maximum(upper, turned.max(axis=0))
    size = upper - lower
    longest = float(size.max())
    if not math.isfinite(longest) or longest <= 0:
        raise ValueError("GLB 尺寸无效")
    scale = 1 / longest
    shift = np.array([-(lower[0] + upper[0]) / 2, -lower[1],
                      -(lower[2] + upper[2]) / 2])
    transform = np.eye(4)
    transform[:3, :3] = scale * rotation
    transform[:3, 3] = scale * shift
    nodes = document.setdefault("nodes", [])
    nodes.append({"name": "encounter-normalization", "matrix": transform.T.reshape(-1).tolist(),
                  "children": roots})
    scenes[scene_index]["nodes"] = [len(nodes) - 1]
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    chunks = [(b"JSON", encoded), *parts[1:]]
    payload = b"".join(struct.pack("<I4s", len(data), kind) + data for kind, data in chunks)
    output = struct.pack("<4sII", b"glTF", 2, 12 + len(payload)) + payload
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(output)
    temporary.replace(destination)
    return [round(float(value), 6) for value in size * scale]


def optimize_glb(source: Path, destination: Path, *, enabled: bool = True) -> dict:
    """Build a browser-friendly GLB, keeping uncompressed geometry for loader compatibility."""
    import shutil

    destination.parent.mkdir(parents=True, exist_ok=True)
    if not enabled:
        shutil.copyfile(source, destination)
    else:
        root = Path(__file__).resolve().parents[2]
        executable = root / "node_modules" / ".bin" / ("gltf-transform.cmd" if os.name == "nt" else "gltf-transform")
        if not executable.exists():
            raise RuntimeError("缺少 glTF Transform；先在项目根目录运行 npm ci，或使用 --no-optimize")
        temporary = destination.with_name(destination.stem + ".tmp.glb")
        command = [str(executable), "optimize", str(source), str(temporary),
                   "--compress", "false", "--texture-compress", "webp",
                   "--texture-size", "1024", "--simplify-ratio", "0.08",
                   "--simplify-error", "0.005"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
        if result.returncode:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"GLB 优化失败: {(result.stderr or result.stdout)[-500:]}")
        temporary.replace(destination)
    _chunks(destination.read_bytes())
    scene = trimesh.load(destination, force="scene", process=False)
    if not scene.geometry or scene.bounds is None:
        raise ValueError("优化后 GLB 无有效几何体")
    faces = sum(len(mesh.faces) for mesh in scene.geometry.values())
    if not faces:
        raise ValueError("优化后 GLB 无三角面")
    return {"bytes": destination.stat().st_size, "faces": faces}


def export_glb(source: Path, destination: Path, *, texture_size: int = 512) -> dict:
    """Resize textures for a GLB download without changing mesh transforms or pivot."""
    if texture_size not in (512, 1024, 2048, 4096, 8192):
        raise ValueError("贴图分辨率必须为 512/1024/2048/4096/8192")
    _chunks(source.read_bytes())
    root = Path(__file__).resolve().parents[2]
    executable = root / "node_modules" / ".bin" / ("gltf-transform.cmd" if os.name == "nt" else "gltf-transform")
    if not executable.exists():
        raise RuntimeError("缺少 glTF Transform；请先运行 npm ci")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.stem + f".{uuid.uuid4().hex}.tmp.glb")
    command = [str(executable), "resize", str(source), str(temporary),
               "--width", str(texture_size), "--height", str(texture_size)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
    if result.returncode:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"GLB 导出失败: {(result.stderr or result.stdout)[-500:]}")
    _chunks(temporary.read_bytes())
    temporary.replace(destination)
    scene = trimesh.load(destination, force="scene", process=False)
    if not scene.geometry or scene.bounds is None:
        raise ValueError("导出后 GLB 无有效几何体")
    return {"bytes": destination.stat().st_size,
            "faces": sum(len(mesh.faces) for mesh in scene.geometry.values()),
            "texture_size": texture_size, "pivot_to_center_bottom": False}
