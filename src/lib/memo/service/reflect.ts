// 反思服务（spec §4.8）：模型提出规则操作 → 代码校验（锁定条款、用户规则、证据、重复、底线说法）→ 返回通过的操作。
// 应用（生成 version + 1）在手机上做，画像不出手机（D5）。
import { toAgentError } from "../../agent/errors";
import { clip } from "../../agent/redact";
import { runAgent } from "../../agent/run";
import { TraceBuilder } from "../../agent/trace";
import { validateReflectOps, type OpRejection } from "../learning";
import { buildReflectPrompt, buildReflectSystem, REFLECT_SUBMIT_NAME } from "../prompts/reflect";
import { reflectOutputSchema, type ReflectOp, type ReflectRequest } from "../schema";
import type { AgentTrace, ProfileRule } from "../types";

export interface ReflectResult {
  ops: ReflectOp[];
  rejected: OpRejection[];
  summary: string;
  trace: AgentTrace;
}

export async function reflectProfile(req: ReflectRequest, opts: { modelId?: string } = {}): Promise<ReflectResult> {
  const trace = new TraceBuilder("reflect", `profile-v${req.profile.version}`, { runId: req.runId });
  try {
    const locked = req.profile.rules.filter((r) => r.locked).map((r) => ({ id: r.id, text: r.text }));
    const counts = req.events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {});
    trace.push({ kind: "stage", name: "context", ms: 0, summary: `画像 v${req.profile.version}：${req.profile.rules.length} 条规则（锁定 ${locked.length}）；反馈 ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join("、")}` });

    const result = await runAgent({
      role: "reflect",
      modelOverride: opts.modelId ? { modelId: opts.modelId } : undefined,
      system: buildReflectSystem(locked),
      prompt: buildReflectPrompt(req),
      submit: { name: REFLECT_SUBMIT_NAME, description: "规则更新操作", schema: reflectOutputSchema },
      deadlineMs: 45_000,
      trace,
      temperature: 0.2,
      maxOutputTokens: 1_500,
    });

    const rules = req.profile.rules.map((r) => ({ ...r, createdAt: "", updatedAt: "" })) as ProfileRule[];
    const known = new Set(req.events.map((e) => e.moment.momentId));
    const { accepted, rejected } = validateReflectOps(result.output.ops, rules, known);
    for (const r of rejected) {
      trace.push({ kind: "guard", name: `reject_${r.op.op}`, ms: 0, summary: `代码拒绝：${r.reason}（${clip(r.op.text, 20)}）` });
    }
    trace.push({ kind: "check", name: "ops", ms: 0, summary: `模型提出 ${result.output.ops.length} 个操作，代码校验通过 ${accepted.length} 个` });
    return { ops: accepted, rejected, summary: clip(result.output.summary, 60), trace: trace.build("ok") };
  } catch (error) {
    const e = toAgentError(error);
    trace.push({ kind: "error", name: e.code, ms: 0, summary: e.message });
    e.trace = trace.build("failed", e.limitHit);
    throw e;
  }
}
