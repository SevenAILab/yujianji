// 给业务工具套一层：计次上限、单个超时、trace 记录。
// 业务失败以结构化结果返回；意外异常照常抛出，由 AI SDK 转成工具错误交还模型自己纠正（借鉴 Claude Code）。
import type { Tool, ToolSet } from "ai";
import type { TraceBuilder } from "../trace";
import { clip, summarizeToolInput, summarizeToolOutput } from "../redact";

export interface ToolCounter {
  used: number;
}

export function instrumentTools(
  tools: ToolSet,
  ctx: { trace: TraceBuilder; maxToolCalls: number; toolTimeoutMs: number; counter: ToolCounter },
): ToolSet {
  const out: ToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    const execute = (original as { execute?: (input: unknown, options: unknown) => unknown }).execute;
    if (!execute) {
      out[name] = original;
      continue;
    }
    out[name] = {
      ...original,
      execute: async (input: unknown, options: unknown) => {
        const startedAt = Date.now();
        if (ctx.counter.used >= ctx.maxToolCalls) {
          ctx.trace.push({ kind: "guard", name, ms: 0, summary: `业务工具已调用 ${ctx.maxToolCalls} 次（上限），本次未执行，提示模型直接交卷` });
          return { error: "TOOL_LIMIT", hint: "工具调用次数已用完，请根据已有信息直接交卷" };
        }
        ctx.counter.used += 1;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve(execute(input, options)),
            new Promise((resolve) => {
              timer = setTimeout(
                () => resolve({ error: "TIMEOUT", hint: `超过 ${Math.round(ctx.toolTimeoutMs / 1000)} 秒没有返回` }),
                ctx.toolTimeoutMs,
              );
            }),
          ]);
          ctx.trace.push({
            kind: "tool",
            name,
            ms: Date.now() - startedAt,
            summary: `${summarizeToolInput(name, input)} → ${summarizeToolOutput(name, result)}`,
          });
          return result;
        } catch (error) {
          ctx.trace.push({
            kind: "error",
            name,
            ms: Date.now() - startedAt,
            summary: `${summarizeToolInput(name, input)} → 工具异常，已作为错误结果交还模型：${clip(error instanceof Error ? error.message : String(error), 60)}`,
          });
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    } as Tool;
  }
  return out;
}
