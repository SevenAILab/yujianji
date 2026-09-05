# 遇见集

一个把照片、边拍边说的视频和文字变成个人旅行博物志的手机网页 MVP。

用户可以上传旅途中拍摄的图片、短视频或文字。AI 会理解画面和上下文，自动生成一页“遇见记录”，介绍当地风物、自然知识与旅途奇遇；用户也可以围绕记录继续向 AI 提问，让它成为一路陪伴、一起发现的旅行搭子。

一段旅程结束后，遇见集会把多条记录串成路线轨迹，并生成可分享的拼贴插画，让旅行不只停留在相册里，而是成为一份可以回看和讲述的个人博物志。

## 当前进展

目前仓库是移动端 Web MVP，已经支持：

- 上传或拍摄图片，补充原话、语音、地点与定位信息；
- 由视觉模型识别内容，生成分类、介绍、趣闻、判断依据及“初见 / 重逢”关系；
- 在记录详情页继续追问 AI，查看个人旅行博物志；
- 在世界地图查看足迹，按时间范围生成旅程总结；
- 在 `/journeys` 按区域串联记录，生成旅程拼贴与成长轨迹；
- 数据保存在浏览器 IndexedDB，本地生成竖版分享卡，并可生成带缩略图的网页分享链接。

影石 X6 的接入方式不是直连相机，而是手机中继：用户在 Insta360 App 中把 360 照片导出到手机相册，再在遇见集的设备页或新建遇见页导入。路线轨迹、旅程拼贴和分享闭环已具备基础页面，后续重点是设备兼容与真实用户验证。

## 技术栈

- **应用框架**：Next.js 16（App Router）+ React 19 + TypeScript；
- **界面与地图**：Tailwind CSS 4、D3 Geo / Zoom、TopoJSON 与 World Atlas；
- **AI 能力**：通过 OpenAI 兼容接口调用阿里云百炼视觉模型，完成图片理解、结构化内容生成、追问与旅程总结；
- **数据与校验**：Dexie + IndexedDB 负责端侧存储，Zod 校验模型返回和接口数据；
- **图像与分享**：浏览器 Canvas 负责图片压缩、`1080 × 1920` 分享卡生成，以及轻量网页分享链接。
- **原生壳**：Capacitor 8，提供 Android/iOS 离线壳与后续原生能力桥接；
- **测试与部署**：Vitest，支持部署到 Vercel。

核心页面包括世界地图 `/`、新建遇见 `/encounter`、记录详情 `/item/[id]`、旅程拼贴 `/journeys`、设备导入 `/devices`、公开分享 `/share` 和旅程合集 `/firsts`；服务端接口集中在 `src/app/api`，分别处理识别、地图聚合、旅程总结与拼贴生成。

## 项目文档

- `BP.md`：一页版内部 BP，梳理定位、差异化、商业模式和最小验证目标。
- `BP_Pitch.md`：黑客松路演版 BP，突出“自我成长”叙事、影石 X6 场景和分享闭环。

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

在 `.env.local` 中配置百炼 API：

```dotenv
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3-vl-plus
GEOCODING_BASE_URL=https://nominatim.openstreetmap.org
GEOCODING_USER_AGENT=yujianji/0.1 (+https://github.com/SevenAILab/yujianji)
OMNI_MODEL=qwen3.5-omni-plus
LLM_THINKING=false
LLM_JSON_MODE=true
```

地点校准默认通过服务端代理调用 Nominatim，只在用户保存记录时查询一次，并进行缓存和限速。公开服务最多允许每秒一次请求，正式扩大用户量前应通过 `GEOCODING_BASE_URL` 切换到自建或商业服务。地点数据来自 OpenStreetMap contributors，使用时需遵守 ODbL 和 [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)。

门 0 检查两个模型及参数组合：

```bash
npm run ping
```

该命令会测试 `qwen3-vl-plus`、`qwen-vl-max`，并对 `qwen3-vl-plus` 对比 thinking 与 JSON mode；日志只输出耗时、返回长度和 reasoning 是否存在。`qwen-vl-max` 的 thinking 参数如果被服务商拒绝，备用模型仍可验证关闭 thinking 与 JSON mode。现场切换备用模型时，只修改 `VISION_MODEL` 后重新部署，不需要改代码。

## Seed 内容

当前仓库包含 25 条用于演示的 seed 记录，覆盖莫干山粉色叶子、青海玄武岩、七姐妹白崖，以及物件、食物和动物照片。seed 只使用无人脸、无私人可识别信息的风景、植物、动物、食物或物件照片；正式路演前仍应逐张复核公开素材与地点文案。

```bash
npm run seed:check
npm run seed:check:final
```

`seed:check` 是当前开发门，默认至少 3 条；`seed:check:final` 是路演门，要求至少 20 条。两份 seed JSON 必须一致，所有 seed 必须是 `first`，且 `luck.basis` 非空；类别门要求至少 2 条 `artifact`、1 条 `food`、2 条 `animal`。

批量生成 AI 字段：

```bash
npm run seed:ai
```

脚本会读取本地图片、调用百炼、逐条做 schema 校验；任意一条失败都不会落盘。模型生成后需要人工校对 `data/seed.json`，再同步到 `public/seed-data.json`。

### 公开素材说明

`public/seed/` 中的公开风景素材用于黑客松演示，不代表用户真实上传内容。来源包括团队确认的自有旅行照片，以及按可公开演示要求下载并压缩到仓库中的 Unsplash 图片；如果替换或新增素材，必须同步记录原始页面、作者和许可证信息，并先确认没有人脸、车牌、住址或其他私人可识别信息。模型生成的识别、趣闻和地点关联均需人工复核，页面会保留“AI 生成，未经核实”提示。

本轮新增素材来自 Unsplash 图片直链，按 Unsplash License 用于演示：

- `ceramic-mug.jpg`: photo id `1514228742587-6b1558fcca3d`
- `coffee-cup.jpg`: photo id `1495474472287-4d71bcdd2085`
- `pizza.jpg`: photo id `1513104890138-7c749659a591`
- `dog.jpg`: photo id `1552053831-71594a27632d`
- `cat.jpg`: photo id `1518791841217-8f162f1e1131`

图片均已人工检查为无可识别人物信息的物件、食物或动物素材。

## 页面

- `/` 世界地图、国家/Admin-1 高亮、统计和最近遇见
- `/encounter` 拍照/视频/相册、原话、语音输入、地点、定位降级、显影和手动保存
- `/item/[id]` 初见/重逢、AI 博物志、依据、追问、分享图、网页分享链接和删除
- `/share` 打开朋友发来的遇见记录分享页，不依赖账号或服务端存储
- `/journeys` 按区域串联遇见记录，生成旅程拼贴和成长轨迹
- `/devices` 影石 X6 手机中继导入、自动同步入口和存储管理入口
- `/firsts` 只统计 `ai.verdict === "first"` 的记录，并支持按日期调用旅程总结

地图使用本地 `world-atlas` 国家几何和 `src/data/admin1-regions.json` 的 Admin-1 几何，不使用地图瓦片或在线地图服务。首页的地图由 `MemoryGlobe` 绘制，地图异常由错误边界隔离，列表与藏品详情仍可访问。`/api/map-pins` 是独立的地图聚合能力。

### P1 / P2

- 语音输入使用浏览器 Web Speech API。iPhone Safari 或 Android Chrome 不支持时，按钮会置灰并提示直接打字。
- 分享图由浏览器 Canvas 本地生成，尺寸固定为 `1080 × 1920`，不经过应用服务端；网页分享链接只包含文本摘要和低清缩略图，也不上传原图。
- 旅程总结在 `/firsts` 中选择日期范围后调用 `/api/summary`，只发送结构化的记录摘要，不发送照片。
- `/api/geocode` 保留为独立的地点查询能力，不是主保存流程依赖；主流程的地点文案由用户填写，GPS 国家判断使用本地多边形。

照片和记录只存用户浏览器的 IndexedDB。识别期间照片会临时发送给百炼模型，应用服务端不保存照片。

## Insta360 X6 360 照片导入

- 当前不直连 X6，使用手机中继：在 Insta360 App 导出 360 照片到手机相册，再打开 `/devices` 点击「导入 360 照片」。
- 文件会以 `insta360` 来源进入 `/encounter`，与相册来源一样读取 EXIF 拍摄时间与定位信息。
- 识别前先在浏览器本地压缩，原 360 图片不写入 IndexedDB；分享链接只携带低清缩略图。

## GO Ultra 视频记录

当前版本不是网页直连影石相机。实际链路是：GO Ultra 录制并在 Insta360 App 中导出到手机相册，再从遇见集的「拍摄」或「从相册选」导入。浏览器会在本机抽取画面帧与 16kHz 单声道音频，原视频不会上传、不会写入 IndexedDB。

- 源文件最大 100MB；超过 60 秒时只在本机处理前 60 秒，并在确认页明确提示，原视频不会保存。
- 按时长均匀抽取 1–6 帧，优先 960px JPEG，并按完整请求体预算自适应降低质量。
- 完整 JSON 请求在客户端限制为 4.2MB；服务端再次校验，帧原始字节合计不超过约 1.1MB，WAV 不超过约 1.95MB。
- Omni 模型返回后先进入确认步骤，用户可以取消卡片、改名称和地点、查看重逢关联，并把不确定的重逢改为初见。
- 语音地点只作为待确认文字。只有它能匹配已有同地点的可信坐标时才沿用坐标；否则记录仍可保存，但不会生成虚假地图 pin。
- `OMNI_MODEL` 默认是 `qwen3.5-omni-plus`，调用采用流式文本输出，服务端不会转发模型流或记录音频、转写与模型原文。

「批量显影」一次最多导入 8 张图片，严格串行调用模型。每张成功后立即写入 IndexedDB，并加入后续图片的历史判断；失败项单独显示且可重试。拍摄时间优先读取 EXIF，读取不到时使用文件 `lastModified`。

## 验证

```bash
# 运行测试
npm test
 npm run seed:check:final

# TypeScript 类型检查
npx tsc --noEmit

# 创建生产构建
npm run build
 git diff --check
 npm audit --omit=dev --audit-level=high
```

 自动化测试覆盖三类契约：Zod schema、模型 JSON 提取、`relatedItemId` 合法性；另外覆盖地图 pin、Admin-1 几何和 Insight 的纯函数边界。相机、GPS、断网、压缩和双设备流程需要用 iPhone Safari 与 Android Chrome 真机验收。

2026-09-05 本轮已完成的本地/生产证据以仓库中的截图和日志为准；真实蜂窝网络截图仍需用手机蜂窝网络补拍，不能由桌面网络验收代替。

## Vercel

1. 将 GitHub `main` 导入 Vercel。
2. 为 Preview 和 Production 分别设置 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`VISION_MODEL`、`OMNI_MODEL` 和 `LLM_JSON_MODE`。
3. 部署后使用手机蜂窝网络验证 `/encounter` 主流程。
4. 比赛结束后禁用或轮换公开 Demo 使用的 API key。

API 使用 Node.js runtime，单次函数最长 60 秒；客户端压缩后的图片 data URL 必须不超过 2MB。限流是单实例内每分钟 120 次的成本保护，多实例部署时不是强全局限流。

## 二维码与局域网

生产二维码：

```bash
npm run qr
# 或指定地址
bash scripts/qr.sh https://yujianji.vercel.app
```

局域网备用：

```bash
PORT=3001 ./scripts/lan.sh
```

脚本会打印本机局域网地址。手机和电脑连接同一 Wi-Fi 后，用二维码或该地址打开。

> 照片和记录默认只保存在用户浏览器中。识别时图片会临时发送给模型，应用服务端不保存原图；地点名称会发送给地点服务用于坐标校准；AI 生成内容仍需用户核实。
