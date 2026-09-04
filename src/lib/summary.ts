import type { HistoryEntry } from "./types";

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

export function cleanSummary(value: string): string {
  return value
    .replace(/^```(?:text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim()
    .slice(0, 150);
}
