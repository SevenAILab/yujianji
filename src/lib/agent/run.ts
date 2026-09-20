// Harness：AI SDK v7 负责循环，交卷、上限、重试、trace 由这里控制（D4、D14）。
//
// S0 第 7 项实测（spikes/memo/results/s0-7-plus.log）：qwen3.5-plus 带工具时，DashScope 忽略 response_format，
// 最终 JSON 被包在 ```json 里，AI SDK 的 Output.object 两种模式都 0/10；改用"交卷工具"10/10。所以：
// - 有业务工具 → 交卷工具模式（借鉴 Claude Code SyntheticOutputTool）：模型必须调用 submit_* 交结果，
//   参数不合 schema 由 AI SDK 回填错误让模型改；没交卷 → 带原因只开放交卷工具补跑一轮 → 仍不交卷明确报错
// - 没有工具（粗筛、写作、自查、反思）→ Output.object（json_object）；解析失败先用 json.ts 确定性修复，
//   再带错误信息重试一次，仍失败 INVALID_MODEL_OUTPUT
import {
  generateText,
  isStepCount,
  NoObjectGeneratedError,
  Output,
  tool,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import { extractJsonObject } from "../json";
import { assertBudget, recordSpend } from "./budget";
import { AgentError, toAgentError } from "./errors";
import { tokenCostYuan } from "./pricing";
import { languageModelFor, numberEnv, type AgentRole } from "./provider";
import type { TraceBuilder } from "./trace";
import { instrumentTools, type ToolCounter } from "./tools/instrument";

export const TOOL_TIMEOUT_MS = 15_000;
/** 剩余时间少于它就不再补跑，直接按上限报错 */
const MIN_RETRY_MS = 6_000;

export function defaultMaxSteps(): number {
  return numberEnv("MEMO_MAX_AGENT_STEPS", 6);
}
export function defaultMaxToolCalls(): number {
  return numberEnv("MEMO_MAX_TOOL_CALLS", 4);
}

export interface SubmitSpec<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
}

export interface RunAgentOptions<T> {
  role: AgentRole;
  modelOverride?: { modelId?: string; provider?: "dashscope" | "eval"; instance?: import("ai").LanguageModel };
  system: string;
  prompt: string;
  tools?: ToolSet;
  submit: SubmitSpec<T>;
  maxSteps?: number;
  maxToolCalls?: number;
  /** 整轮截止时间（毫秒），≤ 50 秒 */
  deadlineMs: number;
  trace: TraceBuilder;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface RunAgentResult<T> {
  output: T;
  steps: number;
  toolCalls: number;
  limitHit?: "steps" | "tool_calls";
  repaired: boolean;
}

interface StepLike {
  stepNumber: number;
  toolCalls: Array<{ toolName: string; invalid?: boolean; input?: unknown }>;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  finishReason: string;
  rawFinishReason?: string | undefined;
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
    .join("；");
}

export function parseModelJson<T>(text: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; issue: string } {
  try {
    const parsed = schema.safeParse(extractJsonObject(text));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issue: zodIssues(parsed.error) };
  } catch (error) {
    return { ok: false, issue: error instanceof Error ? error.message : "无法解析" };
  }
}

export async function runAgent<T>(opts: RunAgentOptions<T>): Promise<RunAgentResult<T>> {
  assertBudget();
  const { model, modelId, providerOptions } = languageModelFor(opts.role, opts.modelOverride);
  const trace = opts.trace;
  trace.setModel(modelId);
  const deadlineAt = Date.now() + opts.deadlineMs;
  const remaining = () => deadlineAt - Date.now();
  const signal = () => AbortSignal.timeout(Math.max(1_000, remaining()));
  const submitName = opts.submit.name;
  let stepStartedAt = Date.now();

  const onStepEnd = (step: StepLike) => {
    const cost = tokenCostYuan(modelId, step.usage.inputTokens, step.usage.outputTokens);
    trace.addCost(cost.yuan, cost.estimated);
    recordSpend(cost.yuan);
    const calls = step.toolCalls;
    const submitted = calls.some((c) => c.toolName === submitName && !c.invalid);
    const invalid = calls.filter((c) => c.invalid).length;
    const business = calls.filter((c) => c.toolName !== submitName).map((c) => c.toolName);
    // 借鉴 Claude Code：以"这一步有没有工具调用"决定继续还是停，模型的结束信号只记录
    const reason = submitted
      ? "调用了交卷工具 → 停止"
      : calls.length > 0
        ? `有 ${calls.length} 个工具调用 → 执行后继续`
        : "没有工具调用 → 停止";
    const action = business.length ? `调用 ${business.join("、")}` : submitted ? "交卷" : calls.length ? "调用工具" : "直接输出";
    trace.push({
      kind: "model",
      name: modelId,
      ms: Date.now() - stepStartedAt,
      inputTokens: step.usage.inputTokens,
      outputTokens: step.usage.outputTokens,
      summary: `第 ${step.stepNumber + 1} 步：${action}${invalid ? `；${invalid} 个调用参数不合 schema，错误已回填给模型` : ""}；模型结束信号 ${step.rawFinishReason ?? step.finishReason}（只记录）`,
      reason,
    });
    stepStartedAt = Date.now();
  };

  const common = {
    model,
    system: opts.system,
    maxRetries: 1,
    temperature: opts.temperature ?? 0.2,
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    providerOptions,
    onStepStart: () => {
      stepStartedAt = Date.now();
    },
    onStepEnd,
  };

  try {
    if (opts.tools && Object.keys(opts.tools).length > 0) {
      return await runWithSubmitTool(opts, { common, remaining, signal, trace, tools: opts.tools });
    }
    return await runWithOutput(opts, { common, remaining, signal, trace });
  } catch (error) {
    throw toAgentError(error);
  }
}

type Common = Record<string, unknown> & { model: unknown; system: string };

async function runWithSubmitTool<T>(
  opts: RunAgentOptions<T>,
  ctx: { common: Common; remaining: () => number; signal: () => AbortSignal; trace: TraceBuilder; tools: ToolSet },
): Promise<RunAgentResult<T>> {
  const submitName = opts.submit.name;
  const maxSteps = opts.maxSteps ?? defaultMaxSteps();
  const maxToolCalls = opts.maxToolCalls ?? defaultMaxToolCalls();
  const counter: ToolCounter = { used: 0 };
  const tools: ToolSet = {
    ...instrumentTools(ctx.tools, { trace: ctx.trace, maxToolCalls, toolTimeoutMs: TOOL_TIMEOUT_MS, counter }),
    [submitName]: tool({
      description: opts.submit.description,
      inputSchema: opts.submit.schema,
      execute: async () => ({ accepted: true }),
    }),
  };

  const findSubmit = (steps: StepLike[]): unknown => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const call = steps[i].toolCalls.find((c) => c.toolName === submitName && !c.invalid);
      if (call) return call.input;
    }
    return undefined;
  };
  const stopOnSubmit: StopCondition<ToolSet> = ({ steps }) =>
    steps.at(-1)?.toolCalls.some((c) => c.toolName === submitName && !c.invalid) ?? false;
  const stopOnToolLimit: StopCondition<ToolSet> = () => counter.used >= maxToolCalls;

  const generate = generateText as unknown as (args: Record<string, unknown>) => Promise<{
    steps: StepLike[];
    responseMessages: ModelMessage[];
    text: string;
  }>;

  const first = await generate({
    ...ctx.common,
    prompt: opts.prompt,
    tools,
    stopWhen: [isStepCount(maxSteps), stopOnSubmit, stopOnToolLimit],
    abortSignal: ctx.signal(),
  });
  let steps = first.steps.length;
  let input = findSubmit(first.steps);
  let limitHit: RunAgentResult<T>["limitHit"];

  if (input === undefined) {
    limitHit = counter.used >= maxToolCalls ? "tool_calls" : steps >= maxSteps ? "steps" : undefined;
    const why =
      limitHit === "tool_calls"
        ? `业务工具已调用 ${maxToolCalls} 次（上限）`
        : limitHit === "steps"
          ? `已经用满 ${maxSteps} 步`
          : `还没有调用 ${submitName} 交卷`;
    if (ctx.remaining() < MIN_RETRY_MS) {
      throw new AgentError("AGENT_BUDGET_EXCEEDED", `${why}，剩余时间不够补跑`, { limitHit: limitHit ?? "deadline" });
    }
    // 借鉴 Claude Code：检查拦下时带着拦截原因再跑一轮；交卷只补一次
    ctx.trace.push({ kind: "retry", name: submitName, ms: 0, summary: `${why} → 带着原因补跑一轮，只开放交卷工具`, reason: "交卷有上限：最多补一次" });
    const messages: ModelMessage[] = [
      { role: "user", content: opts.prompt },
      ...first.responseMessages,
      { role: "user", content: `${why}。请根据已经掌握的信息，现在就调用 ${submitName} 提交最终结果，不要再调用其他工具。` },
    ];
    const second = await generate({
      ...ctx.common,
      messages,
      tools,
      activeTools: [submitName],
      stopWhen: [isStepCount(2), stopOnSubmit],
      abortSignal: ctx.signal(),
    });
    steps += second.steps.length;
    input = findSubmit(second.steps);
    if (input === undefined) {
      const fallback = parseModelJson(second.text, opts.submit.schema);
      if (fallback.ok) {
        ctx.trace.push({ kind: "check", name: "text_fallback", ms: 0, summary: "模型没有调用交卷工具，但文本里的 JSON 通过了 schema，按交卷处理" });
        return { output: fallback.data, steps, toolCalls: counter.used, limitHit, repaired: true };
      }
      throw new AgentError(limitHit ? "AGENT_BUDGET_EXCEEDED" : "INVALID_MODEL_OUTPUT", `${why}，补跑一轮后仍未交卷`, {
        limitHit,
      });
    }
  }

  const parsed = opts.submit.schema.safeParse(input);
  if (!parsed.success) {
    throw new AgentError("INVALID_MODEL_OUTPUT", `交卷内容不合 schema：${zodIssues(parsed.error)}`);
  }
  return { output: parsed.data, steps, toolCalls: counter.used, limitHit, repaired: false };
}

async function runWithOutput<T>(
  opts: RunAgentOptions<T>,
  ctx: { common: Common; remaining: () => number; signal: () => AbortSignal; trace: TraceBuilder },
): Promise<RunAgentResult<T>> {
  const output = Output.object({ schema: opts.submit.schema, name: opts.submit.name, description: opts.submit.description });
  const generate = generateText as unknown as (args: Record<string, unknown>) => Promise<{ output: T }>;

  const attempt = async (args: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; text: string }> => {
    try {
      const result = await generate({ ...ctx.common, ...args, output, abortSignal: ctx.signal() });
      return { ok: true, data: result.output };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) return { ok: false, text: error.text ?? "" };
      throw error;
    }
  };

  const first = await attempt({ prompt: opts.prompt });
  if (first.ok) return { output: first.data, steps: 1, toolCalls: 0, repaired: false };

  const repaired = parseModelJson(first.text, opts.submit.schema);
  if (repaired.ok) {
    ctx.trace.push({ kind: "check", name: "json_repair", ms: 0, summary: "输出包了代码块或有小瑕疵，json.ts 确定性修复后通过 schema" });
    return { output: repaired.data, steps: 1, toolCalls: 0, repaired: true };
  }
  if (ctx.remaining() < MIN_RETRY_MS) {
    throw new AgentError("INVALID_MODEL_OUTPUT", `输出不合 schema：${repaired.issue}`);
  }
  ctx.trace.push({ kind: "retry", name: "invalid_output", ms: 0, summary: `输出不合 schema（${repaired.issue}）→ 带错误信息重试一次` });
  const second = await attempt({
    messages: [
      { role: "user", content: opts.prompt },
      { role: "assistant", content: first.text.slice(0, 6_000) || "（空）" },
      { role: "user", content: `上面的输出不合要求：${repaired.issue}。请只输出一个符合要求的 JSON 对象，不要代码块，不要解释。` },
    ],
  });
  if (second.ok) return { output: second.data, steps: 2, toolCalls: 0, repaired: false };
  const secondRepair = parseModelJson(second.text, opts.submit.schema);
  if (secondRepair.ok) {
    ctx.trace.push({ kind: "check", name: "json_repair", ms: 0, summary: "重试后的输出经 json.ts 修复通过 schema" });
    return { output: secondRepair.data, steps: 2, toolCalls: 0, repaired: true };
  }
  throw new AgentError("INVALID_MODEL_OUTPUT", `重试后输出仍不合 schema：${secondRepair.issue}`);
}
