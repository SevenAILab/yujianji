"""Cached, local GLB export from a completed Tripo generation."""
from pathlib import Path
from urllib.parse import urlparse
import uuid

import httpx

from scripts.pipeline.glb import _chunks

MAX_GLB = 500 * 1024 * 1024


def _trusted_model_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return (parsed.scheme == "https" and parsed.port in (None, 443)
            and (host.endswith(".tripo3d.com") or host.endswith(".tripo3d.ai")))


async def download_model(client: httpx.AsyncClient, url: str, destination: Path) -> None:
    if not _trusted_model_url(url):
        raise ValueError("Tripo 模型链接不是允许的 HTTPS 域名")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + f".{uuid.uuid4().hex}.part")
    try:
        async with client.stream("GET", url, timeout=180, follow_redirects=False) as response:
            response.raise_for_status()
            if response.status_code != 200:
                raise ValueError("Tripo 模型链接发生重定向或返回非 200 状态")
            size = 0
            with temporary.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_GLB:
                        raise ValueError("GLB 超过 500 MB")
                    output.write(chunk)
        _chunks(temporary.read_bytes())
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
