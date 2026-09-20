// 写作服务（spec §4.7）：写 → 确定性检查 → 独立检查员 → 带反馈重写一次 → 仍不过降级为整理后的原话；金句代码逐字校验。
import { toAgentError } from "../../agent/errors";
import { clip } from "../../agent/redact";
import { runAgent } from "../../agent/run";
import { TraceBuilder } from "../../agent/trace";
import { degradeFromQuotes } from "../fillers";
import { checkParagraph, SUBLIMATION_BLACKLIST } from "../fidelity";
import { buildVerifierPrompt, VERIFIER_SUBMIT_NAME, VERIFIER_SYSTEM } from "../prompts/verify";
import { buildWriterPrompt, buildWriterSystem, WRITER_SUBMIT_NAME, type WriterMomentInput } from "../prompts/write";
import { verifyQuotes } from "../quotes";
import { verifierOutputSchema, writerOutputSchema, type WriteRequest } from "../schema";
import { shortDay } from "../time";
import type { AgentTrace, DiaryParagraph } from "../types";

export interface WriteResult {
  title: string;
  quotes: { momentId: string; text: string }[];
  paragraphs: DiaryParagraph[];
  trace: AgentTrace;
}

export interface WriteOptions {
  writerModelId?: string;
  verifierModelId?: string;
}

type WriteMoment = WriteRequest["moments"][number];

/** 重写一轮至少要留这么多时间，否则直接降级（阶段预算：先显示原话） */
const REWRITE_MIN_MS = 20_000;

function byHeading(moments: WriteMoment[], id: string): string {
  return moments.find((m) => m.id === id)?.heading ?? id;
}

function toWriterInput(m: WriteMoment): WriterMomentInput {
  return { id: m.id, heading: m.heading, quotes: m.myQuotes, paraphrase: m.othersParaphrase, trigger: m.trigger };
}

async function verify(
  items: { moment: WriteMoment; text: string }[],
  ctx: { trace: TraceBuilder; deadlineMs: number; modelId?: string },
): Promise<Map<string, string[]>> {
  const issues = new Map<string, string[]>();
  if (!items.length) return issues;
  const startedAt = Date.now();
  try {
    const result = await runAgent({
      role: "verifier",
      modelOverride: ctx.modelId ? { modelId: ctx.modelId } : undefined,
      system: VERIFIER_SYSTEM,
      prompt: buildVerifierPrompt(items.map((i) => ({ momentId: i.moment.id, paragraph: i.text, quotes: i.moment.myQuotes, paraphrase: i.moment.othersParaphrase }))),
      submit: { name: VERIFIER_SUBMIT_NAME, description: "逐段核对结果", schema: verifierOutputSchema },
      deadlineMs: ctx.deadlineMs,
      trace: ctx.trace,
      temperature: 0,
      maxOutputTokens: 2_500,
    });
    const byId = new Map(result.output.results.map((r) => [r.momentId, r.unsupported.map((u) => u.trim()).filter(Boolean)]));
    for (const item of items) {
      const unsupported = byId.get(item.moment.id);
      if (unsupported === undefined) issues.set(item.moment.id, ["检查员漏检了这一段"]);
      else if (unsupported.length) issues.set(item.moment.id, unsupported.map((u) => `无依据：${clip(u, 40)}`));
    }
    ctx.trace.push({ kind: "verify", name: "verifier", ms: Date.now() - startedAt, summary: `独立检查员：${items.length - issues.size}/${items.length} 段每句都能对应到原话` });
  } catch (error) {
    const e = toAgentError(error);
    if (e.code === "BUDGET_EXCEEDED") throw e;
    // 检查员自己挂了 = 没法证明没编 → 宁可朴素：这些段落按不通过处理
    for (const item of items) issues.set(item.moment.id, [`检查员不可用（${e.code}），无法核对`]);
    ctx.trace.push({ kind: "error", name: "verifier_failed", ms: 0, summary: `检查员调用失败（${e.code}），相关段落按未通过处理` });
  }
  return issues;
}

/** 模型常把「时间 · 地点」小标题或 markdown 引用符号写进正文；小标题由代码生成，这里确定性去掉（不改正文内容） */
export function sanitizeParagraph(text: string, heading: string): string {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/^\s*>\s?/, "").trim()).filter(Boolean);
  while (lines.length > 1 && (lines[0].replace(/\*/g, "").trim() === heading || /^\**\s*\d{1,2}[:：]\d{2}\s*[·・]/.test(lines[0]))) lines.shift();
  if (lines.length === 1) lines[0] = lines[0].replace(new RegExp(`^\\**\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\**\\s*`), "");
  return lines.join("").trim();
}

function deterministic(moment: WriteMoment, text: string | undefined): string[] {
  if (!text?.trim()) return ["写作者没有给出这一段"];
  return checkParagraph(text, { myQuotes: moment.myQuotes, othersParaphrase: moment.othersParaphrase }).map((i) => i.detail);
}

export async function writeDiary(req: WriteRequest, opts: WriteOptions = {}): Promise<WriteResult> {
  const trace = new TraceBuilder("write", req.dayKey, { runId: req.runId, dayKey: req.dayKey });
  const deadlineAt = Date.now() + (req.budgetMs ?? 50_000);
  const remaining = () => deadlineAt - Date.now();
  const styleRules = req.profile.rules.filter((r) => r.kind === "style").map((r) => r.text);

  const edited = req.moments.filter((m) => m.userEditedText);
  const toWrite = req.moments.filter((m) => !m.userEditedText);
  if (edited.length) {
    trace.push({ kind: "stage", name: "user_edited", ms: 0, summary: `${edited.length} 段是你改过的文字，原样保留，不重写` });
  }

  const texts = new Map<string, string>();
  const retries = new Map<string, number>();
  const finalIssues = new Map<string, string[]>();
  let title = "";
  let quoteCandidates: { momentId: string; text: string }[] = [];

  try {
    if (toWrite.length) {
      const writerSystem = buildWriterSystem(styleRules);
      let draftOk = false;
      try {
        const draft = await runAgent({
          role: "writer",
          modelOverride: opts.writerModelId ? { modelId: opts.writerModelId } : undefined,
          system: writerSystem,
          prompt: buildWriterPrompt({ dayKey: req.dayKey, moments: toWrite.map(toWriterInput) }),
          submit: { name: WRITER_SUBMIT_NAME, description: "今日手记草稿", schema: writerOutputSchema },
          deadlineMs: Math.max(8_000, Math.min(30_000, remaining() - 12_000)),
          trace,
          temperature: 0.3,
          maxOutputTokens: 2_500,
        });
        draftOk = true;
        title = draft.output.title.trim();
        quoteCandidates = draft.output.quotes;
        for (const p of draft.output.paragraphs) {
          const target = toWrite.find((m) => m.id === p.momentId);
          if (target) texts.set(p.momentId, sanitizeParagraph(p.text, target.heading));
        }
      } catch (error) {
        const e = toAgentError(error);
        if (e.code === "BUDGET_EXCEEDED") throw e;
        trace.push({ kind: "degrade", name: "writer_failed", ms: 0, summary: `写作失败（${e.code}），全部段落降级为整理后的原话` });
      }

      // 第 2 步：确定性检查；第 3 步：独立检查员
      const pending = new Map<string, string[]>();
      for (const m of toWrite) {
        const issues = deterministic(m, texts.get(m.id));
        if (issues.length) pending.set(m.id, issues);
      }
      if (draftOk) {
        trace.push({ kind: "check", name: "fidelity", ms: 0, summary: `确定性检查：${toWrite.length - pending.size}/${toWrite.length} 段通过（长度、升华黑名单、引号、数字和英文）` });
        for (const [id, issues] of pending) {
          trace.push({ kind: "check", name: "fidelity_issue", ms: 0, summary: `${byHeading(toWrite, id)}：${issues.slice(0, 3).join("；")}` });
        }
        const verifyItems = toWrite.filter((m) => texts.has(m.id) && !pending.has(m.id)).map((m) => ({ moment: m, text: texts.get(m.id)! }));
        const verifierIssues = await verify(verifyItems, { trace, deadlineMs: Math.max(6_000, Math.min(25_000, remaining() - 8_000)), modelId: opts.verifierModelId });
        for (const [id, issues] of verifierIssues) pending.set(id, issues);
      }

      // 第 4 步：带反馈重写一次（时间够才重写，否则直接降级：先显示原话）
      if (pending.size && draftOk) {
        if (remaining() < REWRITE_MIN_MS) {
          trace.push({ kind: "degrade", name: "skip_rewrite", ms: 0, summary: `剩余 ${Math.round(remaining() / 1000)} 秒，不够重写一轮，${pending.size} 段直接降级为原话` });
          for (const [id, issues] of pending) finalIssues.set(id, issues);
        } else {
          const targets = toWrite.filter((m) => pending.has(m.id));
          trace.push({ kind: "retry", name: "rewrite", ms: 0, summary: `${targets.length} 段没通过，带着问题重写一次`, reason: "借鉴 Claude Code：检查拦下时带着原因重跑一轮" });
          const rewritten = new Map<string, string>();
          try {
            const redo = await runAgent({
              role: "writer",
              modelOverride: opts.writerModelId ? { modelId: opts.writerModelId } : undefined,
              system: writerSystem,
              prompt: buildWriterPrompt({
                dayKey: req.dayKey,
                moments: targets.map(toWriterInput),
                rewrite: targets.map((m) => ({ momentId: m.id, previous: texts.get(m.id) ?? "（上一版缺这一段）", issues: pending.get(m.id)! })),
              }),
              submit: { name: WRITER_SUBMIT_NAME, description: "重写的段落", schema: writerOutputSchema },
              deadlineMs: Math.max(6_000, Math.min(20_000, remaining() - 10_000)),
              trace,
              temperature: 0.3,
              maxOutputTokens: 2_000,
            });
            for (const p of redo.output.paragraphs) {
              const target = targets.find((m) => m.id === p.momentId);
              if (target) rewritten.set(p.momentId, sanitizeParagraph(p.text, target.heading));
            }
          } catch (error) {
            const e = toAgentError(error);
            if (e.code === "BUDGET_EXCEEDED") throw e;
            trace.push({ kind: "error", name: "rewrite_failed", ms: 0, summary: `重写调用失败（${e.code}）` });
          }
          const stillBad = new Map<string, string[]>();
          for (const m of targets) {
            retries.set(m.id, 1);
            const text = rewritten.get(m.id);
            const issues = deterministic(m, text);
            if (issues.length) stillBad.set(m.id, issues);
            else texts.set(m.id, text!);
          }
          const reverifyItems = targets.filter((m) => rewritten.has(m.id) && !stillBad.has(m.id)).map((m) => ({ moment: m, text: rewritten.get(m.id)! }));
          if (reverifyItems.length) {
            const again = await verify(reverifyItems, { trace, deadlineMs: Math.max(5_000, remaining() - 2_000), modelId: opts.verifierModelId });
            for (const [id, issues] of again) stillBad.set(id, issues);
          }
          for (const [id, issues] of stillBad) finalIssues.set(id, issues);
        }
      } else if (!draftOk) {
        for (const m of toWrite) finalIssues.set(m.id, ["写作失败"]);
      }
    }
  } catch (error) {
    const e = toAgentError(error);
    trace.push({ kind: "error", name: e.code, ms: 0, summary: e.message });
    e.trace = trace.build("failed");
    throw e;
  }

  const paragraphs: DiaryParagraph[] = req.moments.map((m) => {
    if (m.userEditedText) {
      return { momentId: m.id, heading: m.heading, text: m.userEditedText, verified: false, degraded: false, retries: 0, userEdited: true };
    }
    const issues = finalIssues.get(m.id);
    if (issues) {
      trace.push({ kind: "degrade", name: "plain_quotes", ms: 0, summary: `${m.heading}：${issues.slice(0, 2).join("；")} → 显示整理后的原话，标「未润色」` });
      return { momentId: m.id, heading: m.heading, text: degradeFromQuotes(m.myQuotes), verified: false, degraded: true, retries: retries.get(m.id) ?? 0, issues };
    }
    return { momentId: m.id, heading: m.heading, text: texts.get(m.id)!, verified: true, degraded: false, retries: retries.get(m.id) ?? 0 };
  });

  // 第 5 步：今日金句，代码逐字校验
  const quoteCheck = verifyQuotes(
    quoteCandidates,
    req.moments.map((m) => ({ momentId: m.id, myQuotes: m.myQuotes, salience: m.salience })),
  );
  for (const r of quoteCheck.rejected) {
    trace.push({ kind: "guard", name: r.reason === "NOT_VERBATIM" ? "quote_not_verbatim" : `quote_${r.reason.toLowerCase()}`, ms: 0, summary: `金句候选被拦下（${r.reason}）` });
  }
  if (quoteCheck.fallbackUsed) {
    trace.push({ kind: "degrade", name: "quote_fallback", ms: 0, summary: quoteCheck.quotes.length ? "模型给的金句全部不合格，代码从最重要的片段里取了一句原话" : "没有合格的金句" });
  }

  const safeTitle = title && !SUBLIMATION_BLACKLIST.some((w) => title.includes(w)) ? clip(title, 12).replace(/…$/, "") : `${shortDay(req.dayKey)} 的手记`;
  if (safeTitle !== title) trace.push({ kind: "guard", name: "title", ms: 0, summary: title ? "标题超长或含升华说法，已替换" : "没有标题，用日期代替" });

  const degraded = paragraphs.some((p) => p.degraded) || quoteCheck.fallbackUsed;
  return { title: safeTitle, quotes: quoteCheck.quotes, paragraphs, trace: trace.build(degraded ? "degraded" : "ok") };
}
