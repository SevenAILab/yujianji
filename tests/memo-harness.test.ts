import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { recordSpend, resetBudgetForTest } from "../src/lib/agent/budget";
import { AgentError } from "../src/lib/agent/errors";
import { dedupeInflight } from "../src/lib/agent/inflight";
import { clampSummary, summarizeToolInput } from "../src/lib/agent/redact";
import { runAgent } from "../src/lib/agent/run";
import { TraceBuilder } from "../src/lib/agent/trace";

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function callTool(toolName: string, input: unknown, id: string) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
}

const schema = z.object({ moments: z.array(z.object({ id: z.string(), decision: z.enum(["keep", "drop"]) })), sessionNotes: z.string() });
const submit = { name: "submit_judgement", description: "交卷", schema };
const good = { moments: [{ id: "u1", decision: "keep" }], sessionNotes: "在公园" };

function recall(calls: string[]) {
  return {
    recall_memory: tool({
      description: "翻记忆",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        calls.push(query);
        return { lines: [`m1|2026-09-22|海德公园|keep|${query}|原因`] };
      },
    }),
  };
}

function trace() {
  return new TraceBuilder("judge", "w0", { runId: "run_test_1" });
}

beforeEach(() => {
  resetBudgetForTest();
  delete process.env.MEMO_DAILY_BUDGET_YUAN;
});

describe("harness：交卷工具模式", () => {
  it("工具 → 交卷；以有没有工具调用决定继续，trace 记下每一步的原因和费用", async () => {
    const calls: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: [callTool("recall_memory", { query: "草坪" }, "c1"), callTool("submit_judgement", good, "c2")] });
    const t = trace();
    const r = await runAgent({ role: "agent", modelOverride: { instance: model, modelId: "qwen3.5-plus" }, system: "s", prompt: "p", tools: recall(calls), submit, deadlineMs: 10_000, trace: t });
    expect(r.output).toEqual(good);
    expect(calls).toEqual(["草坪"]);
    const built = t.build("ok");
    const models = built.steps.filter((s) => s.kind === "model");
    expect(models.map((s) => s.reason)).toEqual(["有 1 个工具调用 → 执行后继续", "调用了交卷工具 → 停止"]);
    expect(built.steps.find((s) => s.kind === "tool")?.summary).toContain("命中");
    expect(built.costYuan).toBeCloseTo((2 * (1000 * 0.8 + 100 * 4.8)) / 1e6, 8);
  });

  it("交卷参数不合 schema → 错误回填给模型，下一步改对后通过", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [callTool("submit_judgement", { moments: [{ id: "u1", decision: "maybe" }], sessionNotes: "" }, "c1"), callTool("submit_judgement", good, "c2")],
    });
    const t = trace();
    const r = await runAgent({ role: "agent", modelOverride: { instance: model }, system: "s", prompt: "p", tools: recall([]), submit, deadlineMs: 10_000, trace: t });
    expect(r.output).toEqual(good);
    expect(t.build("ok").steps[0].summary).toContain("不合 schema");
  });

  it("模型没交卷就停了 → 带原因补跑一轮（只开放交卷工具）", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text("我判断完了"), callTool("submit_judgement", good, "c2")] });
    const t = trace();
    const r = await runAgent({ role: "agent", modelOverride: { instance: model }, system: "s", prompt: "p", tools: recall([]), submit, deadlineMs: 10_000, trace: t });
    expect(r.output).toEqual(good);
    expect(t.build("ok").steps.some((s) => s.kind === "retry")).toBe(true);
    expect(model.doGenerateCalls[1].tools?.map((x) => x.name)).toEqual(["submit_judgement"]);
  });

  it("补跑一轮仍不交卷 → INVALID_MODEL_OUTPUT，明确报错", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text("不交"), text("还是不交")] });
    await expect(
      runAgent({ role: "agent", modelOverride: { instance: model }, system: "s", prompt: "p", tools: recall([]), submit, deadlineMs: 10_000, trace: trace() }),
    ).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("工具调用达到上限 → 停下并要求直接交卷，limitHit=tool_calls", async () => {
    const calls: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [callTool("recall_memory", { query: "a" }, "c1"), callTool("recall_memory", { query: "b" }, "c2"), callTool("submit_judgement", good, "c3")],
    });
    const r = await runAgent({ role: "agent", modelOverride: { instance: model }, system: "s", prompt: "p", tools: recall(calls), submit, maxToolCalls: 1, deadlineMs: 10_000, trace: trace() });
    expect(calls).toEqual(["a"]);
    expect(r.limitHit).toBe("tool_calls");
    expect(r.output).toEqual(good);
  });

  it("步数用满仍没交卷、补跑也不交 → AGENT_BUDGET_EXCEEDED(steps)", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [callTool("recall_memory", { query: "a" }, "c1"), callTool("recall_memory", { query: "b" }, "c2"), text("不交")],
    });
    const error = await runAgent({ role: "agent", modelOverride: { instance: model }, system: "s", prompt: "p", tools: recall([]), submit, maxSteps: 2, maxToolCalls: 9, deadlineMs: 10_000, trace: trace() }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", limitHit: "steps" });
  });
});

describe("harness：无工具模式", () => {
  it("JSON 包在代码块里（千问常见）→ json.ts 确定性修复，不多花一次调用", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text("```json\n" + JSON.stringify(good) + "\n```")] });
    const t = trace();
    const r = await runAgent({ role: "writer", modelOverride: { instance: model }, system: "s", prompt: "输出 JSON", submit, deadlineMs: 10_000, trace: t });
    expect(r).toMatchObject({ output: good, repaired: true, steps: 1 });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("不合 schema → 带错误信息重试一次 → 仍失败 INVALID_MODEL_OUTPUT", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text('{"moments": 1}'), text('{"nope": true}')] });
    await expect(runAgent({ role: "writer", modelOverride: { instance: model }, system: "s", prompt: "p", submit, deadlineMs: 10_000, trace: trace() })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("当日预算用完 → 调模型前就返回 BUDGET_EXCEEDED", async () => {
    process.env.MEMO_DAILY_BUDGET_YUAN = "0.01";
    recordSpend(0.02);
    const model = new MockLanguageModelV4({ doGenerate: [text(JSON.stringify(good))] });
    await expect(runAgent({ role: "writer", modelOverride: { instance: model }, system: "s", prompt: "p", submit, deadlineMs: 10_000, trace: trace() })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("trace 脱敏与请求合并", () => {
  it("抹掉手机号、邮箱；工具参数只取白名单字段；摘要 ≤ 200 字", () => {
    expect(clampSummary(`联系 13812345678 或 a.b@example.com ${"字".repeat(300)}`)).toMatch(/^联系 \[手机号\] 或 \[邮箱\]/);
    expect([...clampSummary("字".repeat(300))].length).toBe(201);
    expect(summarizeToolInput("lookup_fact", { entity: "伦敦塔桥", question: "哪年建成", secret: "不该出现" })).toBe("entity=伦敦塔桥，question=哪年建成");
  });

  it("同一个 runId 的并发重复请求只调一次模型；完成后不保留结果", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const [a, b] = await Promise.all([dedupeInflight("k", fn), dedupeInflight("k", fn)]);
    expect(calls).toBe(1);
    expect([a.joined, b.joined].sort()).toEqual([false, true]);
    await dedupeInflight("k", fn);
    expect(calls).toBe(2);
  });
});
