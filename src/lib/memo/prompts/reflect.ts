// 反思提示词（spec §4.8）：先读现有规则清单，能改已有的就不新增（借鉴 Claude Code 写记忆前先看清单）。
import { CATEGORY_LABELS, type ReflectRequest } from "../schema";

export const REFLECT_SUBMIT_NAME = "reflect_ops";

export function buildReflectSystem(lockedRules: { id: string; text: string }[]): string {
  return `你是「遇见手记」的反思 Agent。根据用户最近的操作，更新「它眼中的我」—— 一条条人话规则，决定以后留什么、丢什么、怎么写。

## 操作的含义
- delete（删掉一段）：这类不该留
- restore（从折叠区捞回）：漏判了，这类该留
- copy（复制）：这段特别好（弱信号）
- edit（改了措辞）：看改前改后，是文风偏好

## 规矩
1. 先读现有规则清单。能修改已有规则就用 update，不要新增意思重复的规则，避免规则越堆越多。
2. 每条规则写成不超过 40 字的人话，像「排队、交通这类抱怨，你不留。」必须在 evidenceMomentIds 里引用本次操作里的片段 id。
3. 证据要充分：同一类操作至少 2 次，或 1 次删除 / 捞回且特征非常明确，才出 op；证据不够就返回空 ops，在 summary 里说明。
4. 下面这些锁定条款不能修改、停用，也不能新增和它们冲突的规则（比如"可以补充没说过的话""可以留别人的原话或隐私"）：
${lockedRules.map((r) => `   - [${r.id}] ${r.text}`).join("\n")}
5. origin=user 的规则是用户亲手写的，优先级最高，不要修改或停用。
6. 只能用 add / update / deactivate 三种操作；kind 是 keep（该留）/ drop（该丢）/ style（文风）。

只输出 JSON：{"ops":[{"op":"add|update|deactivate","ruleId":"update 和 deactivate 必填","kind":"keep|drop|style","text":"≤ 40 字","evidenceMomentIds":["..."]}],"summary":"≤ 60 字，这次学到了什么"}`;
}

export function buildReflectPrompt(req: ReflectRequest): string {
  const rules = req.profile.rules
    .map((r) => `- [${r.id}] (${r.kind} · ${r.origin}${r.locked ? " · 锁定" : ""}${r.active ? "" : " · 已停用"}) ${r.text}`)
    .join("\n");
  const events = req.events
    .map((e) => {
      const m = e.moment;
      const head = `- ${e.type} · 片段 ${m.momentId} · ${CATEGORY_LABELS[m.category]} · 当时判为 ${m.decision} · 触发「${m.trigger}」· 原因「${m.why}」`;
      const quotes = m.quotes.length ? `\n  原话摘要：${m.quotes.map((q) => `「${q}」`).join(" ")}` : "";
      const edit = e.type === "edit" ? `\n  改前：${e.before ?? ""}\n  改后：${e.after ?? ""}` : "";
      return `${head}${quotes}${edit}`;
    })
    .join("\n");
  return `## 现有规则（版本 v${req.profile.version}）\n${rules}\n\n## 最近的操作\n${events}`;
}
