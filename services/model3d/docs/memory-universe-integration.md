# 照片 → GLB → 记忆图景宇宙

渲染基线：`memory-scene-universe-v2-globe`（`memory-scene-2` 标签 `e649c60`）。保留中心地球、三主色粒子、18 万粒子预算、中心 5 件与外层球壳、相机穿行及点击地球进入世界线。

## 启动

1. 在 `遇见集-照片转3D模型模块` 安装 Python 3.11+ 依赖：`python -m pip install -r requirements.txt`。随目录附带的 Windows `.venv` 不适用于 macOS，请建立本机环境。
2. 后端 `.env` 设置 `TRIPO_API_KEY`，然后在模块目录执行 `python -m scripts.serve_universe`。该入口明确读取模块 `.env`、将 `DATA_DIR` 解析到模块目录，并仅监听 `127.0.0.1:8000`。
3. 本前端目录安装依赖并执行 `npm run dev`。默认代理后端 `http://127.0.0.1:8000`。
4. 首页点「记忆宇宙」进入 `/universe`，右上角点「照片变成记忆」，选择照片、内容类型，点「生成并加入宇宙」。生成会使用 Tripo 额度。

前端服务端可设置：

```dotenv
MEMORY_3D_API_URL=http://127.0.0.1:8000
MEMORY_3D_SERVICE_KEY=
```

若后端配置了 `SERVICE_API_KEY`，前端 `MEMORY_3D_SERVICE_KEY` 必须一致。两者都不能使用 `NEXT_PUBLIC_` 前缀。远程后端必须使用 HTTPS 且配置服务密钥。

后端 `UNIVERSE_DAILY_LIMIT=20` 默认限制滚动 24 小时内的新任务总数；同一浏览器空间最多有 3 个进行中的任务。测试时可用 `UNIVERSE_WORKER=0` 禁用自动执行。只能运行单 worker；数据目录锁阻止多个进程同时提交任务。

## 数据流与文件

浏览器 → `/api/memory-3d/*` 同源代理 → 后端 `/v1/universe/*`。

- `POST jobs`：multipart `file,name,category,input_mode`，带 `Idempotency-Key`。
- `GET jobs` / `GET jobs/{id}`：持久任务、状态、进度及完成后的模型相对路径。
- `POST jobs/{id}/resume`：仅恢复查询或下载，不新建付费任务。
- `GET models/{id}`：已完成的 GLB 二进制。

原照片在 `DATA_DIR/universe/photos`，完成的 GLB 在 `DATA_DIR/universe/models/<job_id>.glb`，任务在 `DATA_DIR/jobs.sqlite3` 的 `universe_jobs` 表。

该链路直接缓存 Tripo 原始 GLB，不调用依赖 gltf-transform 的贴图压缩导出；前端自行统一模型尺寸、采样主色与粒子。下载验证沿用后端 Tripo 域名白名单与 GLB 格式检查。

只有 `ready` 模型进入渲染清单，按完成时间固定排序。不是公开扫描整个 `data` 目录；旧演示文件夹和其他未关联到该空间的历史模型不会自动混入。

刷新页面可恢复任务及已有模型。重复提交相同照片和相同设置复用同一任务；提交结果不明时显示人工核对提示，不自动重建。队列是单任务串行处理，成功后下载到磁盘再发布。

每个浏览器使用本地保存的随机访问凭证隔离空间，代理仅转发该凭证而不暴露服务或 Tripo 密钥。这是当前单机匿名空间机制，**不是账号登录**；清空浏览器数据或换浏览器不会自动找回空间。正式多用户上线前需接入产品账号和权限体系。

## 渲染文件维护

编辑源目录 `memory-scene-2` 后运行 `node scripts/sync-memory-universe.mjs`。`predev`、`prebuild` 自动执行同步；独立部署前端时使用随仓库保存的 `public/memory-universe` 文件。新版 `/universe` 页面使用同源 iframe，允许同源嵌入并校验来自指定 iframe 的地球点击消息；点击中心地球返回新版首页地图。基于 GitHub main `e037912` 集成，保留新版首页、录音、旅途和个人页。

## 验证

- 后端：`python -m pytest tests/test_universe.py tests/test_api.py tests/test_tripo.py`。
- 前端：`npm test -- tests/memory-3d-proxy.test.ts`；`npx tsc --noEmit`。
- 浏览器：本地假上游复用现有 GLB，验证上传、状态轮询、自动渲染、刷新恢复；不将测试模型写入真实后端数据目录。
- 单独的真实 Tripo 生成尚需用户上传照片验证，此次开发测试不消费生成额度。
