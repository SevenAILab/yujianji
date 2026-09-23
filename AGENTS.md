<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 开发执行边界

涉及已有功能的接入或修复时，默认按最小可验证步骤推进；每一步完成后先报告结果，再进行下一步。

- 不重复实现已经存在且可复用的后端任务队列、缓存、重试或接口能力。
- 不重复检查全部 API；只核对当前改动直接依赖的接口、字段和调用链。
- 不执行全量回归，除非改动范围、失败线索或用户明确要求使其必要；优先运行针对性的类型检查和测试。
- 不模拟完整第三方流程；除非用户要求或真实服务不可用时需要定位问题，优先验证本地接口边界。
- 不反复打开多个页面；以一个明确的验证页面和一次必要的交互为准。
- 不读取大文件全文；优先读取相关函数、冲突区、差异和搜索结果。
- 在第三方生成、付费请求或会消耗服务额度的操作前，先完成本地和接口层验证；实际请求仅在用户明确要求验证时发起。
