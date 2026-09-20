// 粗筛服务：路由和 eval 共用，不依赖 Next。
import { toAgentError } from "../../agent/errors";
import { runAgent } from "../../agent/run";
import { TraceBuilder } from "../../agent/trace";
import type { z } from "zod";
import { buildTriagePrompt, TRIAGE_SUBMIT_NAME, TRIAGE_SYSTEM } from "../prompts/triage";
import { triageOutputSchema, type judgeWindowSchema } from "../schema";
import type { AgentTrace } from "../types";
import { MIN_ME_CHARS } from "../windows";

export interface TriageResult {
  action: "judge" | "skip";
  reason: string;
  trace: AgentTrace;
}

export async function triageWindow(
  input: { runId: string; window: z.infer<typeof judgeWindowSchema>; sessionId?: string },
  opts: { modelId?: string } = {},
): Promise<TriageResult> {
  const trace = new TraceBuilder("triage", input.window.id, { runId: input.runId, sessionId: input.sessionId });
  const meChars = input.window.utterances
    .filter((u) => u.speaker !== "other")
    .reduce((sum, u) => sum + u.text.length, 0);

  if (meChars < MIN_ME_CHARS) {
    trace.push({ kind: "guard", name: "skip:no_me_speech", ms: 0, summary: `"我"（含拿不准）只说了 ${meChars} 字，少于 ${MIN_ME_CHARS} 字，不调模型` });
    return { action: "skip", reason: "你在这段几乎没说话", trace: trace.build("ok") };
  }

  try {
    const result = await runAgent({
      role: "triage",
      modelOverride: opts.modelId ? { modelId: opts.modelId } : undefined,
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(input.window),
      submit: { name: TRIAGE_SUBMIT_NAME, description: "粗筛结果", schema: triageOutputSchema },
      deadlineMs: 20_000,
      trace,
      temperature: 0,
      maxOutputTokens: 200,
    });
    trace.push({ kind: "check", name: "triage", ms: 0, summary: `${result.output.action}：${result.output.reason}` });
    return { action: result.output.action, reason: result.output.reason, trace: trace.build("ok") };
  } catch (error) {
    const agentError = toAgentError(error);
    if (agentError.code === "BUDGET_EXCEEDED") {
      agentError.trace = trace.build("failed");
      throw agentError;
    }
    // 粗筛失败不拦主流程：按"拿不准一律 judge"处理，显式标 degraded
    trace.push({ kind: "degrade", name: "triage_failed", ms: 0, summary: `粗筛失败（${agentError.code}），按"拿不准一律 judge"交给主模型` });
    return { action: "judge", reason: "粗筛失败，交给主模型", trace: trace.build("degraded") };
  }
}
