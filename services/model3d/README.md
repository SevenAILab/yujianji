# 图片到 3D 模型后端

独立的 FastAPI 服务，支持从一张照片识别、分类和保存多个物体，逐个裁切并提交 Tripo 生成 GLB。原有单物体接口继续可用。文件和任务元数据保存在本机 `DATA_DIR`（SQLite）；可以与其他服务通过 HTTP 接口集成。

## 流程和质量策略

1. 上传 JPEG/PNG/WebP；验证真实文件、EXIF 朝向、尺寸和 20 MB 限制。配置 `OPENAI_API_KEY` 时识别最多 8 个独立主体，给出名称、类别、标签、归一化框、置信度、遮挡和可见特征。识别结果存入 SQLite，可按类别、标签和审核状态查询。未配置视觉密钥时明确返回 `vision_status=not_configured`，可人工补标，不会伪造识别结果。
2. 查看每个物体的裁切预览并修正标签或位置框。裁切使用服务端保存的原图，四周留 8% 余量，等比缩放到居中的方形画布；处理后的 PNG 缓存于 `DATA_DIR/cutouts`。可选背景去除。低置信度或遮挡的物体默认 `needs_review`，不会自动提交付费建模。
3. 上传处理后的 PNG 到 Tripo v3，生成 3D 的请求启用纹理、PBR 和 Tripo 图片自动修复。类别给出默认档位：角色、生物、载具、建筑建议 `high`，家具、道具、武器、植物及其他建议 `standard`；调用方可覆盖。`high` 使用 detailed 几何及纹理，速度与额度开销更高。返回任务 ID，由调用方轮询。成功后可通过本服务的导出接口取得 GLB，也可读取 Tripo 原始 `model_url`；签名链接过期前应及时导出。

Tripo [图片生成模型接口](https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard)本身不接收 `prompt`/`negative_prompt`：识别得到的 `description` 用于人工审核和后续扩展，**不会**被偷偷传给图片建模。文字提示词若要直接驱动造型，属于单独的 [text-to-model](https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard) 或先生成/编辑参考图的流程；提示词宜写形态、材质、色彩、完整轮廓、独立主体和干净背景，但不能保证细节凭空正确。分类只决定可覆盖的质量档位，不改变物体内容。

## 启动

Python 3.11+：

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
$env:TRIPO_API_KEY = "你的 Tripo key"
$env:OPENAI_API_KEY = "可选的视觉识别 key"
$env:SERVICE_API_KEY = "建议部署时设置一个服务密钥"
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8000
```

国内区域可将 `TRIPO_BASE_URL` 配成 `https://openapi.tripo3d.com/v3`；以账户所属区域的官方文档为准。可选抠图依赖：`pip install "rembg[cpu]"`，首次使用需下载模型权重。默认关闭抠图以保护细小边缘。服务部署到公网时必须配置 `SERVICE_API_KEY`、HTTPS、上传限流与访问控制；不要把 Tripo/OpenAI 密钥交给浏览器。OpenAI 识别会把输入图像发送至其 API。

## 供另一个服务调用

调用方只需 HTTP，无需安装本项目代码。服务端持有 Tripo 和视觉识别密钥；调用方只传图片、业务幂等键和可选的 `X-Service-Key`。下列地址以本机 `http://127.0.0.1:8000` 为例；跨机器调用须换成服务的实际 HTTPS 地址。`GET /health` 可检查服务状态，`/docs` 提供交互式接口文档。若未配置 `OPENAI_API_KEY`，分析接口返回 `vision_status=not_configured` 和空 `objects`，此时可人工添加物体；Tripo 密钥不能代替视觉识别密钥。

### 推荐流程：一张照片生成多件物体

| 步骤 | 接口 | 结果 |
| --- | --- | --- |
| 上传并识图 | `POST /v1/analyses`，表单字段 `file` | `analysis_id`、`vision_status`、`objects` |
| 检查裁切 | `GET /v1/analyses/{analysis_id}/objects/{object_id}/preview` | 将送往 Tripo 的 PNG；若建模时启用抠图，预览也应传 `remove_background=true` |
| 修正或补充 | `PATCH /v1/analyses/{analysis_id}/objects/{object_id}`；`POST /v1/analyses/{analysis_id}/objects` | 更新标签、框和审核状态，或新增漏检物体 |
| 分类检索 | `GET /v1/objects?category=furniture&tag=木质&review_status=ready` | 分页返回 `total` 和 `objects`；支持 `limit`、`offset` |
| 提交多件 | `POST /v1/analyses/{analysis_id}/generations`，JSON 含 `object_ids`，请求头含 `Idempotency-Key` | 每件物体独立的 `generation_id`、`task_id` 或跳过原因 |
| 跟踪结果 | `GET /v1/analyses/{analysis_id}/generations`；`GET /v1/generations/{generation_id}` | 任务列表、实时状态及成功后的 `output.model_url` |
| 下载模型 | `GET /v1/generations/{generation_id}/export` | 按下述默认参数导出的 GLB 文件 |

识图最多返回 8 件可独立建模物体。每件物体包含稳定 `id`、`name`、`category`、`tags`、归一化 `bbox=[x1,y1,x2,y2]`、`confidence`、`occluded` 和 `review_status`。类别为 `character`、`creature`、`furniture`、`prop`、`weapon`、`vehicle`、`building`、`plant` 或 `other`；标签是另外保存的短词，便于按材质、用途等检索。被遮挡或置信度低于 0.7 的识别结果标为 `needs_review`，不会提交付费建模。人工新增的物体默认 `ready`。`PATCH` 只需传要修改的字段，例如 `{"tags":["木质","座椅"],"review_status":"ready"}`；已有任务的物体不能再改 `bbox` 或 `category`。

下面的 Python 示例演示上传、选择已审核物体、提交和查询。部署时将 `service_headers` 填上服务密钥；**同一批业务操作重试时保持相同的 `Idempotency-Key`**。

```python
import time
import httpx

base = "http://127.0.0.1:8000"
service_headers = {"X-Service-Key": "你的服务密钥"}  # 未配置 SERVICE_API_KEY 时可用 {}
batch_key = "encounter-123-models"          # 来自调用方业务 ID，重试时不变

with httpx.Client(timeout=600) as client:
    with open("scene.jpg", "rb") as photo:
        response = client.post(
            f"{base}/v1/analyses", headers=service_headers,
            files={"file": ("scene.jpg", photo, "image/jpeg")},
        )
    response.raise_for_status()
    analysis = response.json()
    analysis_id = analysis["analysis_id"]
    ready_ids = [obj["id"] for obj in analysis["objects"]
                 if obj["review_status"] == "ready"]

    # 可以先获取每件物体的 /preview，再 PATCH 错框、标签或审核状态。
    if not ready_ids:
        raise RuntimeError(f"没有可提交的物体：{analysis['vision_status']}")
    response = client.post(
        f"{base}/v1/analyses/{analysis_id}/generations",
        headers={**service_headers, "Idempotency-Key": batch_key},
        json={"object_ids": ready_ids, "quality": "auto"},
    )
    response.raise_for_status()
    for item in response.json()["results"]:
        if item["state"] != "submitted":
            print("未提交：", item)
            continue
        generation_id = item["generation_id"]
        for _ in range(120):
            result = client.get(f"{base}/v1/generations/{generation_id}",
                                headers=service_headers).json()
            if result["state"] == "success":
                exported = client.get(f"{base}{result['export_url']}", headers=service_headers)
                exported.raise_for_status()
                with open(f"{item['object_id']}.glb", "wb") as output:
                    output.write(exported.content)
                break
            if result["state"] in {"failed", "cancelled", "submission_unknown"}:
                raise RuntimeError(result)
            time.sleep(5)
```

`POST /v1/analyses/{analysis_id}/objects` 可在漏检时人工补标，JSON 示例：`{"name":"木椅","category":"furniture","bbox":[0.1,0.1,0.9,0.9],"tags":["木质","座椅"]}`。批次请求最多 8 个不同 `object_ids`；`needs_review`/`rejected` 会返回 `skipped`。批次逐件提交，全部完成提交后才返回 HTTP 202；客户端等待时间应覆盖上传耗时。重复发送**相同名单和参数**且使用相同幂等键，会复用已提交任务；审核后可以用原批次请求继续提交先前跳过的物体。相同键换名单或参数返回 409。图片上传失败可用相同键重试；付费任务创建若返回 `submission_unknown`，不得换键自动重试，应先核对 Tripo 控制台，避免重复扣费。

### GLB 导出参数（按截图）

对已成功的任务调用 `GET /v1/generations/{generation_id}/export`。当前默认值对应截图：

| 参数 | 值 | 行为 |
| --- | --- | --- |
| `format` | `GLB` | 返回 `.glb` 二进制文件；当前只支持 GLB |
| `texture_size` | `512` | 将已有贴图的宽、高分别限制到最多 512 像素，不放大小贴图 |
| `pivot_to_center_bottom` | `false` | 保留 Tripo 原始轴点，不做底部中心平移 |
| `filename` | 物体名称 + `3d模型` | 下载文件名；可指定，如 `白色兰花3d模型` |

例如：`GET /v1/generations/{generation_id}/export?filename=白色兰花3d模型`。下载响应带 `X-Export-Format`、`X-Texture-Size`、`X-Pivot-To-Center-Bottom`，方便调用方核对。该接口在本机缓存原始和导出的 GLB，用本地 glTF Transform 缩小贴图，**不再创建 Tripo 付费转换任务**；首次请求可能需要下载和处理几十 MB 的模型。它保留网格面数与原始轴点，所以 512 贴图不一定使 GLB 文件大幅缩小。此处的 `false` 对应 Tripo [格式转换文档](https://developers.tripo3d.ai/zh/docs/models-convert)里的 `pivot_to_center_bottom=false`。需要先运行 `npm ci` 安装 glTF Transform。

现有 Encounter 前端轻量化流程另有归一化和减面步骤，其 GLB 用于网页预览与堆叠摆放，**不是这个原轴点导出文件**；不要把二者的坐标系当成相同。

### 兼容接口：一张图片生成单件模型

`POST /v1/image-to-3d` 仍可供只需要一件模型的服务使用，上传 `multipart/form-data`，请求头带 `Idempotency-Key`。`file` 必填；`quality=auto|standard|high`，可传 `target_index` 选识别结果，或用 `category`、`target_name`、`bbox` 人工指定物体。`remove_background` 默认 `false`；需安装 `rembg[cpu]` 才能开启。`input_mode=object` 默认裁切主体并置于方形画布；`environment` 保留整张照片视野，不能同时抠背景。识别出多件却未指定主体时返回 409 和候选列表；未识别到主体且未传 `category` 时返回 422，两种情况都不会提交 Tripo。也可先 `POST /v1/analyses`，再用 `POST /v1/generations` 对已确认的单个 `object_id` 建模。

预览和上传使用服务端保存的**原图**裁切，不截取浏览器画面。标签和物体记录存入 SQLite，处理后的 PNG 缓存在 `DATA_DIR/cutouts`，GLB 导出缓存在 `DATA_DIR/exports`。此 API 不自动把多件 GLB 组装成房间。位置框不是像素级分割，遮挡严重或照片中不可见的结构无法靠裁切补全。单图直出真实室内环境的限制见[试验记录](examples/real-environment/README.md)。

SQLite 适合单机部署；多实例需共享数据库与文件存储，并补充上传限流和任务清理。所有非健康检查接口在配置 `SERVICE_API_KEY` 后都需要 `X-Service-Key`。

## 开源调研

- [Tripo 官方 JS SDK](https://github.com/VAST-AI-Research/tripo-js-sdk) 有 v3 任务、上传、重试示例；本服务直接用 HTTP，便于独立部署。SDK 的自动重试策略不适合无幂等保证的付费创建请求。
- [TripoSR](https://github.com/VAST-AI-Research/TripoSR) 是本地单图重建的另一条路线，其裁切主体/去背景流程值得参考，但不等同于付费 Tripo API 的质量与接口。
- [rembg](https://github.com/danielgatis/rembg) 可选抠图；代码 MIT，具体下载的模型权重仍需核对使用许可。对商业服务不直接默认引入需要另外核对许可的检测模型。

验证：`pip install -r requirements-dev.txt; pytest -q`。单元测试用模拟上游，不扣 Tripo 额度；真实端到端需提供有效 API key 和图片。

## Encounter 离线资产批处理

协作文档中的前端只读取 `public/assets/encounters.json` 与本地模型。`scripts/pipeline/batch.py` 是**每条 Encounter 选择一个主体、输出一个 GLB**的离线资产流程；上面的多物体分析和批量提交接口尚未自动写回该前端 JSON。脚本保存每个付费任务的幂等键、任务 ID 和进度到 `.pipeline/state.json`，并把成功模型下载、归一化（Y 向上、底面 Y=0、最长边=1）及轻量化。原图、裁切图、模型、稀有度字段按 Encounter `id` 对应。模型 URL 是站内 `/assets/models/<id>.glb`，不会把临时签名 URL 写到前端 JSON。

当前仓库有一条 ImageGen 生成的**模拟遇见照片**：`public/assets/photos/ceramic-fox-photo.png`，它是真实感合成图，不是真实拍摄。对应主体框和档位放在 `scripts/pipeline/subjects.json`，不污染前端数据契约。正式数据可替换 `encounters.json` 和照片；每个需要人工指定的物件在 subjects 文件中配置 `category`、`bbox`、`quality`、可选 `removeBackground` 与 `yaw`。不指定 `category` 时会用现有可选视觉识别；若识别出多个主体，需要先确定选哪个。

```powershell
pip install -r requirements.txt
npm ci                         # 安装本地 glTF Transform 轻量化工具
$env:TRIPO_API_KEY = "你的密钥" # 只放服务进程，不写入文件或前端
uvicorn app.main:app --host 127.0.0.1 --port 8000
# 另开终端：
python -m scripts.pipeline.batch --dry-run
python -m scripts.pipeline.batch
```

如果项目根目录已有 `.env`，可直接执行 `python -m scripts.run_batch_local`：启动器临时开启本地 API、加载 `.env`，运行批处理后自动关闭服务。`.env` 已加入忽略规则；不要提交密钥。首次付费运行前先执行 `python -m scripts.run_batch_local --dry-run`。

批处理可重复运行：同一照片和设置复用原任务；处理中断后再次执行会查询原任务。`submission_unknown` 需先人工核对 Tripo 控制台，避免换幂等键重复扣费。`--no-optimize` 可在未安装 Node 工具时输出较大的原始 GLB。轻量化默认采用 WebP 贴图、最多 1024 像素纹理、约 8% 目标顶点比例、0.5% 误差上限；输出仍需由前端在目标设备上视觉验收。参考样例从 58.2 MB 降到 5.4 MB、约 15.2 万面，质量阈值和最终 8 件精选模型需实际筛选。

选出 8 条可用资产后，运行 `python -m scripts.pipeline.offline_pack --ids id1 id2 id3 ...`。脚本验证站内照片、cutout、GLB、bbox 和稀有度，生成仅包含精选 Encounter 的 `output/encounter-offline-assets.zip` 与体积/面数清单。该 ZIP 是静态资产包；演示站的 Next.js 代码与依赖需由目标仓库另行准备并预装，断网演练要从本机启动完整站点。

若环境配置 `OPENAI_API_KEY`，批处理会按 `label` 缓存定性的常见度评估，并按 `firstSeen` 调整稀有度。拒绝含数字统计或非法分数的理由，失败写 `uncommon/30/暂未评级`。这不是客观稀有度统计；上线前应由产品确认分数口径。可选去背景仍需额外安装 `rembg[cpu]`。照片和模型仅保存在本机；正式部署请使用可备份的资产存储并处理版权及隐私授权。

### 堆叠打印文件

A 侧提供 `public/assets/stack.json` 后可运行 `python -m scripts.pipeline.export_stack`，输出 `output/print/encounter-stack.3mf`、STL 和 `print-report.json`。约定输入为 `{"items":[{"id":"ceramic-fox","position":[0,0,0],"quaternion":[0,0,0,1],"scale":[1,1,1]}],"baseDiameterMm":80}`。位置和缩放使用归一化的 Y-up 场景单位；`--unit-mm 40` 将 1 单位换算为 40 毫米，脚本旋转到切片软件的 Z-up 坐标并添加底盘。报告会列出非水密网格数；该导出只完成摆放和封装，不做布尔并体或自动补洞，正式打印前仍需在切片软件检查连接、壁厚和悬空结构。

### 陶狐狸实测（2026-09-22）

使用 ImageGen 生成的真实感合成照片，主体框 `[0.35,0.16,0.70,0.82]`，`standard` 档且未开启去背景。Tripo 任务从创建到完成 **148 秒、30 积分**；原始 GLB **42.2 MB**，前端 GLB **3.75 MB、117,574 面**，浏览器交互预览正常。成果为 `public/assets/models/ceramic-fox.glb`、`examples/ceramic-fox-preview.webp`；`python -m scripts.run_batch_local` 再运行会显示 `cached`，不会重复提交。单件离线包可用 `python -m scripts.pipeline.offline_pack --ids ceramic-fox --min-ready 1` 生成。测试打印文件可用 `python -m scripts.pipeline.export_stack --stack examples/encounters/ceramic-fox-stack.json --output output/print-fox` 生成；当前网格报告有 1 个非水密壳，正式打印前必须修补并用切片软件检查。此次输入为合成照片，也未达到文档的 60 秒目标。

另有[环境建模试验](examples/environment/README.md)：将带地板、墙和家具的微缩酒馆角落整图送入 Tripo，得到可旋转的整体 GLB。它适合展示型场景摆件；如需可进入、可编辑的环境，应拆分墙、地面和独立物件后组装。

[真实酒馆照片直出试验](examples/real-environment/README.md)使用 `input_mode=environment` 送入整张实拍照片。Tripo 最终只建出了照片中显眼的木隔断，未生成完整房间；此模式保留输入画幅，但不能保证单张真实室内照片成为场景模型。
