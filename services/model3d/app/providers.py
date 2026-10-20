"""External API adapters. Only idempotent reads/uploads are retried."""
import asyncio
import base64
import json

import httpx


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


async def _request(client: httpx.AsyncClient, method: str, url: str, *, retry: bool = False, **kwargs) -> dict:
    for attempt in range(3 if retry else 1):
        try:
            response = await client.request(method, url, **kwargs)
            if retry and response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                await asyncio.sleep(.5 * 2**attempt)
                continue
            response.raise_for_status()
            return response.json()
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if retry and attempt < 2:
                await asyncio.sleep(.5 * 2**attempt)
                continue
            raise ProviderError("上游网络超时或连接失败", 503) from exc
        except httpx.HTTPStatusError as exc:
            raise ProviderError(f"上游 HTTP {exc.response.status_code}", 503 if exc.response.status_code >= 500 else 502) from exc
        except ValueError as exc:
            raise ProviderError("上游返回无效 JSON") from exc
    raise ProviderError("上游重试次数已耗尽", 503)


def _data(payload: dict) -> dict:
    if payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
        raise ProviderError(f"Tripo 请求失败 (code={payload.get('code')}, message={str(payload.get('message', ''))[:150]})")
    return payload["data"]


class Tripo:
    def __init__(self, client: httpx.AsyncClient, key: str, base: str):
        self.client, self.base = client, base.rstrip("/")
        self.headers = {"Authorization": f"Bearer {key}"}

    async def upload(self, image: bytes) -> str:
        data = _data(await _request(self.client, "POST", f"{self.base}/files", retry=True,
                    headers=self.headers, files={"file": ("subject.png", image, "image/png")}))
        if not isinstance(data.get("file_token"), str):
            raise ProviderError("Tripo 未返回 file_token")
        return data["file_token"]

    async def generate(self, token: str, quality: str) -> str:
        # Never retry this non-idempotent, billable request automatically.
        if quality == "standard":
            payload = {
                "input": token,
                "model": "v3.0-20250812",
                "enable_image_autofix": True,
                "texture": True,
                "texture_quality": "standard",
                "geometry_quality": "standard",
                "pbr": False,
                "quad": False,
                "face_limit": 169500,
                "generate_parts": False,
                "smart_low_poly": False,
            }
        else:
            payload = {"input": token, "model": "v3.1-20260211",
                       "texture": True, "pbr": True, "texture_quality": "detailed",
                       "geometry_quality": "detailed", "enable_image_autofix": True}
        data = _data(await _request(self.client, "POST", f"{self.base}/generation/image-to-model",
                    headers=self.headers, json=payload))
        if not isinstance(data.get("task_id"), str):
            raise ProviderError("Tripo 未返回 task_id")
        return data["task_id"]

    async def task(self, task_id: str) -> dict:
        return _data(await _request(self.client, "GET", f"{self.base}/tasks/{task_id}",
                                    retry=True, headers=self.headers))


VISION_SCHEMA = {
    "type": "object", "properties": {"objects": {"type": "array", "items": {
        "type": "object", "properties": {
            "name": {"type": "string"}, "category": {"type": "string", "enum": [
                "character", "creature", "furniture", "prop", "weapon", "vehicle", "building", "plant", "other"]},
            "bbox": {"type": "array", "items": {"type": "number"}},
            "confidence": {"type": "number"}, "occluded": {"type": "boolean"},
            "description": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}}},
        "required": ["name", "category", "bbox", "confidence", "occluded", "description", "tags"],
        "additionalProperties": False}}}, "required": ["objects"], "additionalProperties": False}


async def recognize(client: httpx.AsyncClient, key: str, model: str, image: bytes) -> list[dict]:
    prompt = ("识别图中可独立建模的主体，最多8个，不要把背景/阴影当物品。"
              "坐标 bbox 为原图宽高比例 [左,上,右,下]，尽量包含完整外轮廓。"
              "name 用中文；description 用一句话描述可见形态、材质和颜色，不要臆造不可见的背面。"
              "每件物体给 1 到 5 个简短中文标签，优先写材质、用途和可见外观，"
              "不要重复类别或猜测不可见属性。遮挡严重标记 occluded。类别只能从枚举中选。")
    payload = {"model": model, "store": False, "input": [{"role": "user", "content": [
        {"type": "input_text", "text": prompt},
        {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(image).decode(), "detail": "high"}]}],
        "text": {"format": {"type": "json_schema", "name": "scene_objects", "strict": True, "schema": VISION_SCHEMA}}}
    result = await _request(client, "POST", "https://api.openai.com/v1/responses",
                            headers={"Authorization": f"Bearer {key}"}, json=payload)
    try:
        content = next(c["text"] for item in result["output"] if item["type"] == "message"
                       for c in item["content"] if c["type"] == "output_text")
        objects = json.loads(content)["objects"]
        valid = []
        for obj in objects[:8]:
            box = obj["bbox"]
            if len(box) == 4 and 0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1:
                obj["confidence"] = max(0, min(1, float(obj["confidence"])))
                obj["tags"] = list(dict.fromkeys(str(tag).strip().lower()[:40]
                                 for tag in obj.get("tags", []) if str(tag).strip()))[:8]
                valid.append(obj)
        return valid
    except (KeyError, StopIteration, ValueError, TypeError) as exc:
        raise ProviderError("视觉识别结果不完整，请手动标注主体") from exc
