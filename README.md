# 遇见集

一个把“拍到的东西”变成个人旅行博物志的手机网页 MVP。

## 本地启动

```bash
cd /Users/seven/Documents/Hackathon/yujianji
npm install
cp .env.example .env.local
npm run dev -- -H 0.0.0.0 -p 3001
```

打开 `http://localhost:3001`。`3000` 可能被本机其他服务占用，演示时优先使用 `3001`。

局域网备用：

```bash
PORT=3001 ./scripts/lan.sh
```

## 模型配置

在 `.env.local` 填入百炼兼容 OpenAI API 配置：

```dotenv
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3-vl-plus
LLM_THINKING=false
LLM_JSON_MODE=true
```

密钥只放在 `.env.local` 或 Vercel Environment Variables，不提交到 Git。服务端只记录模型名、耗时和返回长度，不记录照片、API key 或模型原文。

门 0 检查两个模型及参数组合：

```bash
npm run ping
```

该命令会测试 `qwen3-vl-plus`、`qwen-vl-max`，并对 `qwen3-vl-plus` 对比 thinking 与 JSON mode；日志只输出耗时、返回长度和 reasoning 是否存在。实测 `qwen-vl-max` 不接受开启 thinking 的参数，因此备用模型只验证关闭 thinking 与 JSON mode。现场切换备用模型时，只修改 `VISION_MODEL` 后重新部署，不需要改代码。

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

- `/` 世界地图、国家高亮、统计和最近遇见
- `/encounter` 拍照/相册、原话、语音输入、地点、定位降级、显影和手动保存
- `/item/[id]` 初见/重逢、AI 博物志、依据、追问、分享图和删除
- `/firsts` 只统计 `ai.verdict === "first"` 的记录，并支持按日期调用旅程总结

### P1 / P2

- 语音输入使用浏览器 Web Speech API。iPhone Safari 或 Android Chrome 不支持时，按钮会置灰并提示直接打字。
- 分享图由浏览器 Canvas 本地生成，尺寸固定为 `1080 × 1920`，不经过应用服务端。
- 旅程总结在 `/firsts` 中选择日期范围后调用 `/api/summary`，只发送结构化的记录摘要，不发送照片。

照片和记录只存用户浏览器的 IndexedDB。识别期间照片会临时发送给百炼模型，应用服务端不保存照片。

## 验证

```bash
npm test
npx tsc --noEmit
npm run build
npm run seed:check
```

自动化测试只覆盖三类契约：Zod schema、模型 JSON 提取、`relatedItemId` 合法性。相机、GPS、断网、压缩和双设备流程需要用 iPhone Safari 与 Android Chrome 真机验收。

2026-09-05 本轮真实验收：

- `npm run ping`：`qwen3-vl-plus` thinking off/on 分别无/有 `reasoning_content`；JSON mode 可用；`qwen-vl-max` 的 thinking 参数被服务商拒绝，因此备用模型仅验证 thinking off 和 JSON mode。
- 本地 API：日常水瓶连续 3 次均为 `unrecognized:false / artifact / first`；粉色叶子为 `reunion → moganshan-pink-leaf-2025-10`。
- 生产 API：JSON mode 连续 5 次均为 `unrecognized:false / artifact / first`；粉色叶子重逢关联正确。
- 生产页面截图：`screenshots/gate5-production.png`。真实蜂窝网络截图仍需用手机蜂窝网络现场补拍，不能由桌面网络验收代替。

## Vercel

1. 将 GitHub `main` 导入 Vercel。
2. 为 Preview 和 Production 分别设置 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`VISION_MODEL`。
3. 部署后使用手机蜂窝网络验证 `/encounter` 主流程。
4. 比赛结束后禁用或轮换公开 Demo 使用的 API key。

API 使用 Node.js runtime，单次函数最长 60 秒；客户端压缩后的 data URL 必须不超过 2MB。限流是单实例内每分钟 120 次的成本保护，多实例部署时不是强全局限流。

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
