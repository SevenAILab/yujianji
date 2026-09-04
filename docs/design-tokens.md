# 遇见集 Design Tokens

这份 token 对齐 Claude Design 参考稿，并服务于真实页面的移动端实现。

## 色彩

| Token | Value | 用途 |
| --- | --- | --- |
| `--ink` | `#183B43` | 主文字 |
| `--teal` | `#2F6F6A` | 主按钮、地图高亮、强调 |
| `--teal-dark` | `#1F5455` | 深色文字、导航 |
| `--sky` | `#E9F6F7` | 页面外围背景 |
| `--paper` | `#FBFDFC` | 卡片表面 |
| `--mint` | `#DCEFEB` | 选中态、初见卡 |
| `--line` | `#DCEAEA` | 输入框和分隔线 |
| `--warning` | `#B96F2F` | 定位降级、低置信度、错误 |

## 字体

- 标题与记忆句：`Noto Serif SC`、`Songti SC`、`STSong`、`Georgia` fallback。
- UI 和正文：`Arial`、`PingFang SC`、`Microsoft YaHei` fallback。
- 不依赖 build-time 网络字体，避免生产构建因外部字体服务失败。

## 形状与节奏

- 手机页面内容宽度：`min(100%, 500px)`。
- 主卡片圆角：`16px`–`22px`。
- 控件圆角：`12px`–`17px`。
- 主要页面底部为 `112px` 安全空间，给固定导航和 iOS safe area 留出位置。
- 地图保持固定比例的 SVG 视口，支持拖动与缩放但不改变 pin 的可读尺寸。

## 状态

- 初见：浅青绿色背景，强调“新的遇见”。
- 重逢：深墨绿色背景，强调历史记忆和双图对照。
- 低置信度：使用 `--warning`，同时显示依据和“AI 生成，未经核实”。
- 位置降级：显式显示 `previous` / `default` / `manual` 来源，不伪装成 GPS。
