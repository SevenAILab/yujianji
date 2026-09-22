// 判断服务（spec §4.6）：Agent 循环 + 工具 → 守卫 G1–G9 → facts 核对 → 补一段候选。路由、实验室、eval 共用。
import type { ToolSet } from "ai";
import { AgentError, toAgentError } from "../../agent/errors";
import { clip } from "../../agent/redact";
import { defaultMaxToolCalls, runAgent } from "../../agent/run";
import { findPhotosTool } from "../../agent/tools/find-photos";
import { lookupFactTool } from "../../agent/tools/lookup-fact";
import { recallMemoryTool } from "../../agent/tools/recall-memory";
import { TraceBuilder } from "../../agent/trace";
import { applyGuards, type GuardedMoment } from "../guards";
import { parseMemoryLine, recallMemory } from "../memory-index";
import { buildJudgeSystem, buildJudgeUserPrompt, JUDGE_SUBMIT_DESCRIPTION, JUDGE_SUBMIT_NAME } from "../prompts/judge";
import { judgeSubmitSchema, type JudgeRequest, type JudgeSubmit } from "../schema";
import { shortDay } from "../time";
import type { AgentTrace, BackfillInfo } from "../types";

export interface JudgedMoment extends GuardedMoment {
  backfillCandidates?: NonNullable<BackfillInfo["candidates"]>;
}

export interface JudgeResult {
  moments: JudgedMoment[];
  sessionNotes: string;
  trace: AgentTrace;
}

export interface JudgeOptions {
  modelOverride?: { modelId?: string; provider?: "dashscope" | "eval" };
  maxSteps?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
}

/** 无工具兜底需要的最少剩余时间 */
const NO_TOOLS_MIN_MS = 15_000;

function backfillCandidates(req: JudgeRequest, moment: GuardedMoment): NonNullable<BackfillInfo["candidates"]> {
  const hits = recallMemory(req.memoryIndex, { query: `${moment.trigger} ${moment.backfillTarget?.place ?? ""}` }).lines;
  const lines = hits.length ? hits : req.memoryIndex.slice(0, 3);
  const seen = new Set<string>();
  const out: NonNullable<BackfillInfo["candidates"]> = [];
  for (const line of lines) {
    const row = parseMemoryLine(line);
    if (!row) continue;
    const key = `${row.dayKey}|${row.place}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dayKey: row.dayKey, place: row.place, momentId: row.momentId, label: `${shortDay(row.dayKey)} · ${row.place} · ${row.trigger}` });
    if (out.length >= 3) break;
  }
  return out;
}

export async function judgeWindow(req: JudgeRequest, opts: JudgeOptions = {}): Promise<JudgeResult> {
  const trace = new TraceBuilder("judge", req.window.id, { runId: req.runId, sessionId: req.session.id });
  const startedAt = Date.now();
  const deadlineMs = opts.deadlineMs ?? 45_000;
  const deadlineAt = startedAt + deadlineMs;
  const maxToolCalls = opts.maxToolCalls ?? defaultMaxToolCalls();

  // 句子 id 换短 id 给模型抄，交卷后换回；换不回的原样保留，由 G1 丢弃
  const shortIds = new Map<string, string>();
  const longIds = new Map<string, string>();
  req.window.utterances.forEach((u, index) => {
    shortIds.set(u.id, `u${index}`);
    longIds.set(`u${index}`, u.id);
  });

  const ledger = new Map<string, string>();
  const hasPhotos = Boolean(req.nearbyItems?.length);
  // 没有任何记忆时不给 recall_memory：eval 里 flash 对着空索引调用了 21 次，白白加时延
  const hasMemory = req.memoryIndex.length > 0 || req.mode === "backfill";
  const tools: ToolSet = {
    ...(hasMemory ? { recall_memory: recallMemoryTool(req.memoryIndex) } : {}),
    lookup_fact: lookupFactTool({ trace, ledger, deadlineAt }),
    ...(hasPhotos ? { find_photos: findPhotosTool(req.nearbyItems!) } : {}),
  };
  const system = buildJudgeSystem({ mode: req.mode, maxToolCalls, hasPhotos, hasMemory, rules: req.profile.rules, examples: req.learnedExamples });
  const prompt = buildJudgeUserPrompt(req, shortIds);
  trace.push({
    kind: "stage",
    name: "context",
    ms: 0,
    summary: `窗口 ${req.window.utterances.length} 句；画像 v${req.profile.version} 规则 ${req.profile.rules.length} 条；学到的例子 ${req.learnedExamples.length} 条；记忆索引 ${req.memoryIndex.length} 行；今天已留 ${req.todayKept.length} 条`,
  });

  let submitted: JudgeSubmit;
  let outcome: AgentTrace["outcome"] = "ok";
  let limitNote: AgentTrace["limitHit"];
  try {
    const result = await runAgent({
      role: "agent",
      modelOverride: opts.modelOverride,
      system,
      prompt,
      tools,
      submit: { name: JUDGE_SUBMIT_NAME, description: JUDGE_SUBMIT_DESCRIPTION, schema: judgeSubmitSchema },
      maxSteps: opts.maxSteps,
      maxToolCalls,
      deadlineMs,
      trace,
      // 实验室要求同一窗口重复跑结果一致（spec S4），判断用最低温度
      temperature: 0,
      maxOutputTokens: 2_500,
    });
    submitted = result.output;
    limitNote = result.limitHit;
  } catch (error) {
    const agentError = toAgentError(error);
    const canFallback =
      (agentError.code === "INVALID_MODEL_OUTPUT" || (agentError.code === "AGENT_BUDGET_EXCEEDED" && agentError.limitHit !== "deadline")) &&
      deadlineAt - Date.now() >= NO_TOOLS_MIN_MS;
    if (!canFallback) {
      trace.push({ kind: "error", name: agentError.code, ms: 0, summary: agentError.message });
      agentError.trace = trace.build("failed", agentError.limitHit);
      throw agentError;
    }
    // spec §7：工具调用不稳 → 单次结构化判断兜底，trace 标 degraded:no_tools
    trace.push({ kind: "degrade", name: "degraded:no_tools", ms: 0, summary: `带工具的循环失败（${agentError.code}），改为不带工具的单次结构化判断` });
    try {
      const fallback = await runAgent({
        role: "agent",
        modelOverride: opts.modelOverride,
        system: `${system}\n\n## 本轮说明\n本轮工具不可用，不要调用任何工具。直接输出 JSON：{"moments":[...],"sessionNotes":"..."}，字段要求同上。`,
        prompt,
        submit: { name: JUDGE_SUBMIT_NAME, description: JUDGE_SUBMIT_DESCRIPTION, schema: judgeSubmitSchema },
        deadlineMs: deadlineAt - Date.now() - 1_000,
        trace,
        maxOutputTokens: 2_500,
      });
      submitted = fallback.output;
      outcome = "degraded";
      limitNote = agentError.limitHit === "deadline" ? undefined : agentError.limitHit;
    } catch (fallbackError) {
      const finalError = toAgentError(fallbackError);
      trace.push({ kind: "error", name: finalError.code, ms: 0, summary: finalError.message });
      finalError.trace = trace.build("failed", finalError.limitHit ?? agentError.limitHit);
      throw finalError;
    }
  }

  const mapped = submitted.moments.map((m) => ({
    ...m,
    sourceUtteranceIds: m.sourceUtteranceIds.map((id) => longIds.get(id.trim()) ?? id),
  }));
  const guarded = applyGuards(mapped, {
    mode: req.mode,
    utterances: req.window.utterances,
    photoCandidateIds: req.nearbyItems?.map((item) => item.id),
  });
  for (const event of guarded.events) {
    trace.push({ kind: event.kind, name: event.code, ms: 0, summary: `片段 #${event.momentIndex + 1}：${event.detail}` });
  }
  if (req.mode === "backfill") {
    // G5b：挂回的目标必须是记忆里真实存在的那天那个地方；对不上索引就不自动挂回（eval 里模型把补录当天的日期当成目标）
    guarded.moments.forEach((m, index) => {
      if (m.needsPlacePick || !m.backfillTarget) return;
      const target = m.backfillTarget;
      const matched = req.memoryIndex.some((line) => {
        const row = parseMemoryLine(line);
        if (!row || row.dayKey !== target.dayKey) return false;
        if (!target.place) return true;
        return row.place.includes(target.place) || target.place.includes(row.place) || row.place.split(/\s*·\s*/).some((part) => part && target.place!.includes(part));
      });
      if (!matched) {
        m.needsPlacePick = true;
        m.guardNotes.push("G5B");
        trace.push({ kind: "guard", name: "G5B", ms: 0, summary: `片段 #${index + 1}：目标 ${target.dayKey} ${target.place ?? ""} 在记忆索引里找不到 → 不自动挂回，让用户选` });
      }
    });
  }

  const moments: JudgedMoment[] = guarded.moments.map((m) => {
    let next: JudgedMoment = m;
    if (m.facts?.length) {
      // G7：facts 只能是 lookup_fact 这一轮真实返回的内容，事实文本以工具结果为准
      const verified = m.facts.flatMap((f) => {
        const hit = ledger.get(f.entity) ?? [...ledger].find(([entity]) => entity.includes(f.entity) || f.entity.includes(entity))?.[1];
        return hit ? [{ entity: f.entity, fact: hit }] : [];
      });
      if (verified.length !== m.facts.length) {
        trace.push({ kind: "guard", name: "G7", ms: 0, summary: `${m.facts.length - verified.length} 条补充事实不是 lookup_fact 真实返回的，已删除` });
      }
      next = { ...next, facts: verified.length ? verified : undefined };
    }
    if (m.needsPlacePick) next = { ...next, backfillCandidates: backfillCandidates(req, m) };
    return next;
  });

  const count = (d: string) => moments.filter((m) => m.decision === d).length;
  trace.push({
    kind: "check",
    name: "result",
    ms: Date.now() - startedAt,
    summary: `交卷 ${submitted.moments.length} 个片段，守卫后 keep ${count("keep")} / fold ${count("fold")} / drop ${count("drop")}${limitNote ? `（触发上限 ${limitNote} 后补交）` : ""}`,
  });

  return { moments, sessionNotes: clip(submitted.sessionNotes, 300), trace: trace.build(outcome, limitNote) };
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}
