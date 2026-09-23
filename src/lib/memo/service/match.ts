// 日终补配图服务：路由和测试共用，不依赖 Next。
import { toAgentError } from "../../agent/errors";
import { runAgent } from "../../agent/run";
import { TraceBuilder } from "../../agent/trace";
import { applyDayMatches } from "../day-match";
import { buildMatchPrompt, MATCH_SUBMIT_NAME, MATCH_SYSTEM } from "../prompts/match";
import { matchOutputSchema, type MatchRequest } from "../schema";
import type { AgentTrace } from "../types";

export interface MatchResult {
  matches: { momentId: string; photoId: string; reason: string }[];
  trace: AgentTrace;
}

export async function matchDayPhotos(input: MatchRequest, opts: { modelId?: string } = {}): Promise<MatchResult> {
  const trace = new TraceBuilder("match", input.dayKey, { runId: input.runId, dayKey: input.dayKey });
  trace.push({ kind: "stage", name: "candidates", ms: 0, summary: `${input.moments.length} 段待补，${input.photos.length} 张候选照片（只给识别名称，不给图片）` });
  try {
    const result = await runAgent({
      role: "triage",
      modelOverride: opts.modelId ? { modelId: opts.modelId } : undefined,
      system: MATCH_SYSTEM,
      prompt: buildMatchPrompt(input),
      submit: { name: MATCH_SUBMIT_NAME, description: "配图结果", schema: matchOutputSchema },
      deadlineMs: 20_000,
      trace,
      temperature: 0,
      maxOutputTokens: 800,
    });
    // 服务端先过一遍守卫，客户端落库前还会再过一遍（它手里才有真实的片段）
    const applied = applyDayMatches(input, result.output);
    for (const note of applied.rejected) trace.push({ kind: "guard", name: "G10", ms: 0, summary: note });
    trace.push({ kind: "check", name: "matched", ms: 0, summary: applied.accepted.length ? applied.accepted.map((a) => `${a.momentId} ← ${a.photoId}：${a.reason}`).join("；") : "没有能配上的" });
    return { matches: applied.accepted, trace: trace.build("ok") };
  } catch (error) {
    const agentError = toAgentError(error);
    agentError.trace = trace.build("failed");
    throw agentError;
  }
}
