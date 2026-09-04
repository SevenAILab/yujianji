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
LLM_JSON_MODE=false
```

密钥只放在 `.env.local` 或 Vercel Environment Variables，不提交到 Git。服务端只记录模型名、耗时和返回长度，不记录照片、API key 或模型原文。

门 0 检查两个模型及参数组合：

```bash
npm run ping
```

该命令会测试 `qwen3-vl-plus`、`qwen-vl-max`，并对比 thinking 与 JSON mode；只输出耗时和长度。现场切换备用模型时，只修改 `VISION_MODEL` 后重新部署，不需要改代码。

## Seed 内容

当前仓库保留 3 条链路占位数据，包含莫干山粉色叶子、青海玄武岩和七姐妹白崖。正式演示前必须由团队确认无人脸、无私人可识别信息的真实照片，替换 `public/seed/*`，再补齐 `data/seed.json`。

```bash
npm run seed:check
npm run seed:check:final
```

`seed:check` 是当前开发门，默认至少 3 条；`seed:check:final` 是路演门，要求至少 20 条。两份 seed JSON 必须一致，所有 seed 必须是 `first`，且 `luck.basis` 非空。

批量生成 AI 字段：

```bash
npm run seed:ai
```

脚本会读取本地图片、调用百炼、逐条做 schema 校验；任意一条失败都不会落盘。模型生成后需要人工校对 `data/seed.json`，再同步到 `public/seed-data.json`。

## 页面

- `/` 世界地图、国家高亮、统计和最近遇见
- `/encounter` 拍照/相册、原话、地点、定位降级、显影和手动保存
- `/item/[id]` 初见/重逢、AI 博物志、依据、追问和删除
- `/firsts` 只统计 `ai.verdict === "first"` 的记录

照片和记录只存用户浏览器的 IndexedDB。识别期间照片会临时发送给百炼模型，应用服务端不保存照片。

## 验证

```bash
npm test
npx tsc --noEmit
npm run build
npm run seed:check
```

自动化测试只覆盖三类契约：Zod schema、模型 JSON 提取、`relatedItemId` 合法性。相机、GPS、断网、压缩和双设备流程需要用 iPhone Safari 与 Android Chrome 真机验收。

## Vercel

1. 将 GitHub `main` 导入 Vercel。
2. 为 Preview 和 Production 分别设置 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`VISION_MODEL`。
3. 部署后使用手机蜂窝网络验证 `/encounter` 主流程。
4. 比赛结束后禁用或轮换公开 Demo 使用的 API key。

API 使用 Node.js runtime，单次函数最长 60 秒；客户端压缩后的 data URL 必须不超过 2MB。限流是单实例内每分钟 120 次的成本保护，多实例部署时不是强全局限流。
