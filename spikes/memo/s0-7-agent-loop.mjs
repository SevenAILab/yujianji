// S0 第 7 项：AI SDK v7 + 千问：带工具的循环 + 结构化输出，连续 N 次。
// 三种交卷方式对比：
//   A = output: Output.object + supportsStructuredOutputs=true（json_schema）
//   B = output: Output.object + supportsStructuredOutputs=false（json_object）
//   C = 交卷工具 submit_judgement + stopWhen hasToolCall（借鉴 Claude Code 的 SyntheticOutputTool 思路），不带 response_format
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, hasToolCall, isStepCount, Output, tool } from "ai";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const modelId = process.argv[2] ?? "qwen3.5-plus";
const runs = Number(process.argv[3] ?? 10);
const modes = (process.argv[4] ?? "A,B,C").split(",");

const momentSchema = z.object({
  sourceUtteranceIds: z.array(z.string()).min(1),
  decision: z.enum(["keep", "fold", "drop"]),
  category: z.enum(["difference", "observation", "memory", "reflection", "first_experience", "retold_fact", "functional", "complaint", "others_only", "guide", "background", "private", "work_task"]),
  salience: z.number().min(0).max(1),
  trigger: z.string().max(60),
  why: z.string().max(60),
});
const judgeSchema = z.object({ moments: z.array(momentSchema), sessionNotes: z.string().max(300) });

const memoryIndex = [
  "m1|2026-09-22|伦敦·海德公园|keep|草坪上的人躺着晒太阳|对休息的反思",
  "m2|2026-09-22|伦敦·大英博物馆|drop|问洗手间|功能性",
  "m3|2026-09-23|伦敦·塔桥|keep|桥修了一百多年还在用|复述的新知",
];

const toolLog = [];
function makeTools(runTag) {
  return {
    recall_memory: tool({
      description: "在用户过去留下的片段索引里按关键词、日期、地点查找，最多返回 10 行。补一段时必须先调用。",
      inputSchema: z.object({ query: z.string().optional(), dayKey: z.string().optional(), place: z.string().optional() }),
      execute: async (input) => {
        toolLog.push({ runTag, tool: "recall_memory", input });
        const q = [input.query, input.place, input.dayKey].filter(Boolean).join(" ");
        const hits = memoryIndex.filter((line) => q.split(/\s+/).some((w) => w && line.includes(w)));
        return { lines: hits.length ? hits : memoryIndex.slice(0, 2), truncated: false };
      },
    }),
    lookup_fact: tool({
      description: "查一个具体实体（地名、建筑、菜名）的一句话事实，≤60 字。只在补一句能让手记更好时调用。",
      inputSchema: z.object({ entity: z.string().min(1), question: z.string().min(1) }),
      execute: async (input) => {
        toolLog.push({ runTag, tool: "lookup_fact", input });
        return { fact: "伦敦塔桥 1894 年建成，是一座开合桥。" };
      },
    }),
  };
}

const system = `你是遇见手记的判断 Agent。你只看"我"说出口的话。
按顺序回答判定题：1) 是"我"说的吗？不是→drop(others_only)；2) 只是功能性事务/抱怨/讲解/私密/事务性工作讨论？是→drop；3) 是新鲜的人事景触发的差异、感受、联想、反思、第一次体验、复述的新知？是→keep。拿不准→fold。
这是一段"补一段"录音：你必须先调用 recall_memory 找它说的是哪天哪个地方。提到具体建筑时可以调用 lookup_fact。工具合计最多 3 次。
最终以 JSON 输出，形如 {"moments":[{"sourceUtteranceIds":["u1"],"decision":"keep","category":"reflection","salience":0.8,"trigger":"...","why":"..."}],"sessionNotes":"..."}，trigger 和 why 各 ≤ 30 字，不出现说话人编号。`;

const windowText = JSON.stringify({
  mode: "backfill",
  window: {
    id: "w1",
    utterances: [
      { id: "u1", isMe: true, text: "回酒店路上我还在想那座桥，一百多年了每天还在开合，我们那边的桥好像修好就不怎么管了。" },
      { id: "u2", isMe: false, text: "对啊，而且它是开合桥。" },
      { id: "u3", isMe: true, text: "晚饭吃什么？楼下那家拉面吧。" },
    ],
  },
});

function providerFor(structured) {
  return createOpenAICompatible({ name: "dashscope", baseURL: env.baseURL, apiKey: env.apiKey, supportsStructuredOutputs: structured, includeUsage: true });
}

async function runOnce(mode, i) {
  const runTag = `${mode}-${i}`;
  const t0 = Date.now();
  const steps = [];
  const base = {
    system,
    prompt: windowText,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(50_000),
    temperature: 0.2,
    providerOptions: { dashscope: { enable_thinking: false } },
    onStepEnd: (step) => {
      steps.push({
        n: step.stepNumber,
        finish: step.finishReason,
        toolCalls: step.toolCalls.map((c) => ({ name: c.toolName, input: c.input, invalid: c.invalid ?? false })),
        toolErrors: step.content.filter((p) => p.type === "tool-error").map((p) => String(p.error).slice(0, 120)),
        in: step.usage.inputTokens,
        out: step.usage.outputTokens,
      });
    },
  };
  try {
    let output;
    if (mode === "A" || mode === "B") {
      const provider = providerFor(mode === "A");
      const result = await generateText({
        ...base,
        model: provider.chatModel(modelId),
        tools: makeTools(runTag),
        stopWhen: isStepCount(5),
        output: Output.object({ schema: judgeSchema, name: "judgement" }),
      });
      output = result.output;
    } else {
      const provider = providerFor(false);
      const tools = {
        ...makeTools(runTag),
        submit_judgement: tool({
          description: "交卷：判断完成后必须调用它提交最终结果。调用后本轮结束。",
          inputSchema: judgeSchema,
          execute: async (input) => ({ accepted: true, count: input.moments.length }),
        }),
      };
      const result = await generateText({
        ...base,
        system: system.replace("最终以 JSON 输出", "判断完成后调用 submit_judgement 交卷，参数"),
        model: provider.chatModel(modelId),
        tools,
        stopWhen: [isStepCount(5), hasToolCall("submit_judgement")],
      });
      const submit = result.steps.flatMap((s) => s.toolCalls).find((c) => c.toolName === "submit_judgement" && !c.invalid);
      if (!submit) throw new Error("NO_SUBMIT");
      output = judgeSchema.parse(submit.input);
    }
    const parsed = judgeSchema.safeParse(output);
    const toolsUsed = steps.flatMap((s) => s.toolCalls.map((c) => c.name));
    return {
      runTag, ok: parsed.success, ms: Date.now() - t0, steps: steps.length,
      toolsUsed, invalidToolCalls: steps.flatMap((s) => s.toolCalls).filter((c) => c.invalid).length,
      toolErrors: steps.flatMap((s) => s.toolErrors),
      recallFirst: toolsUsed[0] === "recall_memory",
      decisions: parsed.success ? parsed.data.moments.map((m) => `${m.sourceUtteranceIds.join("+")}:${m.decision}/${m.category}`) : null,
      tokens: steps.reduce((a, s) => ({ in: a.in + (s.in ?? 0), out: a.out + (s.out ?? 0) }), { in: 0, out: 0 }),
      stepDetail: steps,
    };
  } catch (error) {
    return { runTag, ok: false, ms: Date.now() - t0, steps: steps.length, error: `${error?.name}: ${String(error?.message ?? error).slice(0, 300)}`, stepDetail: steps };
  }
}

const results = [];
for (const mode of modes) {
  // 每种模式内并发 3，缩短总时长
  for (let i = 0; i < runs; i += 3) {
    const batch = await Promise.all(Array.from({ length: Math.min(3, runs - i) }, (_, k) => runOnce(mode, i + k)));
    results.push(...batch);
    for (const r of batch) console.log(JSON.stringify({ ...r, stepDetail: undefined }));
  }
}

const summary = modes.map((mode) => {
  const rs = results.filter((r) => r.runTag.startsWith(`${mode}-`));
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  return {
    mode, model: modelId, runs: rs.length,
    ok: rs.filter((r) => r.ok).length,
    recallFirst: rs.filter((r) => r.recallFirst).length,
    invalidToolCalls: rs.reduce((a, r) => a + (r.invalidToolCalls ?? 0), 0),
    errors: rs.filter((r) => r.error).map((r) => r.error),
    p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
  };
});
console.log("SUMMARY", JSON.stringify(summary, null, 2));
mkdirSync("results", { recursive: true });
writeFileSync(`results/s0-7-${modelId}-${Date.now()}.json`, JSON.stringify({ summary, results, toolLog }, null, 2));
