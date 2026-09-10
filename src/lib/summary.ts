import type { HistoryEntry } from "./types";
import { extractJsonObject } from "./json";

export const SUMMARY_SYSTEM_PROMPT = `你是“遇见集”的旅行记忆编辑。请把用户一段时间内的遇见记录写成一段温柔、具体、克制的中文旅程小结。

只输出正文，不要 Markdown、标题、引号或解释。
要求：
- 150 个汉字以内；
- 必须提到至少一个地点或物件；
- 只根据记录写，不要补造天气、人物、路线或统计；
- 语气像是在帮用户把一趟旅程重新翻开，不要像报表；
- 记录不足两条时，诚实说“这趟旅程还只留下了一两个线索”。`;

export function buildSummaryUserText(entries: HistoryEntry[]): string {
  return `请总结以下遇见记录：
${entries
  .map(
    (entry) =>
      `物件：${entry.name}；类别：${entry.category}；地点：${entry.place}；日期：${entry.date.slice(0, 10)}；原话：${entry.userNote.slice(0, 80)}`,
  )
  .join("\n")}`;
}

const SUMMARY_LIMIT = 150;

/**
 * 实测线上（agnes-2.5-flash + LLM_JSON_MODE=true）返回的是一个 JSON 对象，
 * 旧逻辑把它当正文直接硬切 150 字，用户看到的是 `{"route": [...], "summary": "秋天` 这种半截乱码。
 *
 * 路由已经对总结关掉了 JSON 模式；这里再兜一层：
 * 真返回了对象就取正文字段，取不出来就当失败（返回空串让路由报错重试），
 * 绝不把 JSON 原样给用户看。
 */
export function cleanSummary(value: string): string {
  let text = value.trim();

  if (/^(```(?:json)?\s*)?\{/i.test(text)) {
    try {
      const obj = extractJsonObject(text) as Record<string, unknown> | null;
      const field = ["summary", "text", "content", "正文", "小结"]
        .map((key) => obj?.[key])
        .find((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (!field) return "";
      text = field;
    } catch {
      return "";
    }
  }

  text = text
    .replace(/^```(?:text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();

  return truncateAtSentence(text, SUMMARY_LIMIT);
}

/** 超长时在句号处收尾，而不是把一句话拦腰切断。 */
function truncateAtSentence(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastEnd = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  return lastEnd >= limit / 2 ? head.slice(0, lastEnd + 1) : `${head.slice(0, limit - 1)}…`;
}
