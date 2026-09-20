import { generateText, tool } from "ai";
import { z } from "zod";
import { recordSpend } from "../budget";
import { tokenCostYuan } from "../pricing";
import { languageModelFor, withSearch } from "../provider";
import { clip } from "../redact";
import type { TraceBuilder } from "../trace";

export const FACT_MAX_CHARS = 60;
const FACT_SYSTEM = "你是事实补充助手。用一句不超过 60 字的中文陈述回答，只写可查证的事实，不写观点和感受；查不到可靠信息就只回答「未查到」。";

/**
 * P0（S0 第 8 项 9/16 实测通过：3 个实体 2–4 秒返回合理事实）。
 * 联网搜索经 providerOptions 透传 enable_search；兼容接口不返回来源，所以前端一律标「AI 补充，未经核实」。
 * ledger 记下本轮真实查到的事实，守卫用它核对模型交卷里的 facts，防止编造。
 */
export function lookupFactTool(ctx: { trace: TraceBuilder; ledger: Map<string, string>; deadlineAt: number }) {
  return tool({
    description: "查一个具体实体（地名、建筑、菜名、历史）的一句话背景事实（≤ 60 字，联网搜索）。只在补一句能让手记更好时调用。",
    inputSchema: z.object({
      entity: z.string().min(1).max(40).describe("实体名，比如「伦敦塔桥」"),
      question: z.string().min(1).max(60).describe("想补充的具体问题"),
    }),
    execute: async ({ entity, question }) => {
      if (process.env.MEMO_ENABLE_SEARCH === "false") return { error: "SEARCH_DISABLED" };
      const budget = ctx.deadlineAt - Date.now() - 4_000;
      if (budget < 3_000) return { error: "NO_TIME", hint: "剩余时间不够查资料，请直接交卷" };
      const { model, modelId, providerOptions } = languageModelFor("fact");
      const startedAt = Date.now();
      try {
        const result = await generateText({
          model,
          system: FACT_SYSTEM,
          prompt: `实体：${entity}\n问题：${question}`,
          maxRetries: 0,
          maxOutputTokens: 160,
          temperature: 0,
          abortSignal: AbortSignal.timeout(Math.min(10_000, budget)),
          providerOptions: withSearch(providerOptions),
        });
        const cost = tokenCostYuan(modelId, result.usage.inputTokens, result.usage.outputTokens);
        ctx.trace.addCost(cost.yuan, true); // 搜索按次计费价格未核实
        recordSpend(cost.yuan);
        ctx.trace.push({
          kind: "model",
          name: `${modelId}+search`,
          ms: Date.now() - startedAt,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          summary: `lookup_fact 子调用（联网搜索）：${clip(entity, 20)}`,
        });
        const fact = clip(result.text.trim(), FACT_MAX_CHARS).replace(/…$/, "");
        if (!fact || fact.includes("未查到")) return { error: "NOT_FOUND" };
        ctx.ledger.set(entity, fact);
        return { entity, fact, label: "AI 补充，未经核实" };
      } catch (error) {
        const name = (error as { name?: string })?.name ?? "";
        return { error: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "SEARCH_FAILED" };
      }
    },
  });
}
