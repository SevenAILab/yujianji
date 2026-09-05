# 遇见集

遇见集是一个面向户外旅行爱好者的**旅行记录 Agent**：把散落在相册里的风景与偶遇，整理成有地点、有故事、可以继续探索的地图手帐。

用户可以上传旅途中拍摄的全景、图片或视频（规划支持影石设备素材）。AI 会理解画面和上下文，自动生成一页“遇见记录”，介绍当地风物、自然知识与旅途奇遇；用户也可以围绕记录继续向 AI 提问，让它成为一路陪伴、一起发现的旅行搭子。

一段旅程结束后，遇见集会把多条记录串成路线轨迹，并生成可分享的拼贴插画，让旅行不只停留在相册里，而是成为一份可以回看和讲述的个人博物志。

## 当前进展

目前仓库是移动端 Web MVP，已经支持：

- 上传或拍摄图片，补充原话、语音、地点与定位信息；
- 由视觉模型识别内容，生成分类、介绍、趣闻、判断依据及“初见 / 重逢”关系；
- 在记录详情页继续追问 AI，查看个人旅行博物志；
- 在世界地图查看足迹，按时间范围生成旅程总结；
- 数据保存在浏览器 IndexedDB，本地生成竖版分享卡。

全景 / 视频解析、影石设备素材接入，以及“路线轨迹 + 多记录拼贴插画”正在后续产品规划中。

## 技术栈

- **应用框架**：Next.js 16（App Router）+ React 19 + TypeScript；
- **界面与地图**：Tailwind CSS 4、D3 Geo / Zoom、TopoJSON 与 World Atlas；
- **AI 能力**：通过 OpenAI 兼容接口调用阿里云百炼视觉模型，完成图片理解、结构化内容生成、追问与旅程总结；
- **数据与校验**：Dexie + IndexedDB 负责端侧存储，Zod 校验模型返回和接口数据；
- **图像与分享**：浏览器 Canvas 负责图片压缩与 `1080 × 1920` 分享卡生成；
- **测试与部署**：Vitest，支持部署到 Vercel。

核心页面包括世界地图 `/`、新建遇见 `/encounter`、记录详情 `/item/[id]` 和旅程合集 `/firsts`；服务端接口集中在 `src/app/api`，分别处理识别、地图聚合与旅程总结。

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
```

常用检查：

```bash
# 运行测试
npm test

# TypeScript 类型检查
npx tsc --noEmit

# 创建生产构建
npm run build
```

> 照片和记录默认只保存在用户浏览器中。识别时图片会临时发送给模型，应用服务端不保存原图；AI 生成内容仍需用户核实。
