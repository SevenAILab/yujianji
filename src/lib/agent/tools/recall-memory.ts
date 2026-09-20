import { tool } from "ai";
import { z } from "zod";
import { recallMemory } from "../../memo/memory-index";

/** P0：在请求带来的 memoryIndex 里过滤（纯函数），最多 10 行、总字数 ≤ 1500 */
export function recallMemoryTool(memoryIndex: string[]) {
  return tool({
    description:
      "翻用户过去留下和折叠的片段索引，每行格式：momentId|日期|地点|决定|触发|原因。可按关键词、日期（YYYY-MM-DD）、地点过滤，每次最多返回 10 行。补一段时必须先调用；怀疑和今天或以前的内容重复时也可以调用。",
    inputSchema: z.object({
      query: z.string().max(40).optional().describe("关键词，比如「草坪」「那座桥」"),
      dayKey: z.string().max(10).optional().describe("日期 YYYY-MM-DD"),
      place: z.string().max(40).optional().describe("地点关键词"),
    }),
    execute: async (input) => {
      if (memoryIndex.length === 0) return { error: "EMPTY_MEMORY", hint: "用户还没有任何留下的片段" };
      const result = recallMemory(memoryIndex, input);
      if (result.lines.length === 0) return { error: "NO_MATCH", hint: "换个关键词，或去掉日期、地点再试" };
      return {
        lines: result.lines,
        matched: result.matched,
        truncated: result.truncated,
        ...(result.truncated ? { note: "已截断，只返回最相关的几行" } : {}),
      };
    },
  });
}
