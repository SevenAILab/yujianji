import asyncio
import httpx

from app.providers import Tripo, recognize


def test_tripo_v3_contract():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["authorization"] == "Bearer test"
        if request.url.path == "/v3/files":
            assert b'name="file"' in request.content
            return httpx.Response(200, json={"code": 0, "data": {"file_token": "file_1"}})
        if request.url.path == "/v3/generation/image-to-model":
            import json
            body = json.loads(request.content)
            assert body == {"input": "file_1", "model": "v3.1-20260211", "texture": True,
                            "pbr": True, "texture_quality": "detailed", "geometry_quality": "detailed",
                            "enable_image_autofix": True}
            return httpx.Response(200, json={"code": 0, "data": {"task_id": "task_1"}})
        return httpx.Response(200, json={"code": 0, "data": {"status": "running", "progress": 30}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            api = Tripo(client, "test", "https://openapi.tripo3d.ai/v3")
            token = await api.upload(b"png")
            task_id = await api.generate(token, "high")
            assert (await api.task(task_id))["progress"] == 30

    asyncio.run(run())
    assert len(requests) == 3


def test_tripo_standard_uses_memory_universe_preset():
    def handler(request):
        import json
        assert json.loads(request.content) == {
            "input": "file_1", "model": "v3.0-20250812",
            "enable_image_autofix": True, "texture": True,
            "texture_quality": "standard", "geometry_quality": "standard",
            "pbr": False, "quad": False, "face_limit": 169500,
            "generate_parts": False, "smart_low_poly": False,
        }
        return httpx.Response(200, json={"code": 0, "data": {"task_id": "task_1"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            api = Tripo(client, "test", "https://openapi.tripo3d.ai/v3")
            assert await api.generate("file_1", "standard") == "task_1"

    asyncio.run(run())


def test_vision_contract_and_boxes():
    def handler(request):
        import json
        body = json.loads(request.content)
        assert body["input"][0]["content"][1]["image_url"].startswith("data:image/jpeg;base64,")
        assert body["text"]["format"]["strict"] is True
        return httpx.Response(200, json={"output": [{"type": "message", "content": [{
            "type": "output_text", "text": json.dumps({"objects": [{"name": "杯子", "category": "prop",
                "bbox": [.1, .2, .8, .9], "confidence": .8, "occluded": False,
                "description": "陶瓷杯"}, {"name": "错误框", "category": "prop", "bbox": [0, 0, 2, 2],
                "confidence": .2, "occluded": False, "description": ""}]})}]}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            objects = await recognize(client, "test", "gpt-4o-mini", b"jpeg")
            assert len(objects) == 1 and objects[0]["name"] == "杯子"

    asyncio.run(run())
