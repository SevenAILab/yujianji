// trace 脱敏（spec v3 §6）：trace 会经过服务端响应、存进手机，所以
// 1) 不放完整逐字稿、他人原话、模型的完整输入输出；2) 工具参数只取白名单字段并截断；3) 抹掉手机号、邮箱、证件号等。

export const TRACE_SUMMARY_MAX = 200;
const FIELD_MAX = 30;

const PII: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[邮箱]"],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号]"],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "[证件号]"],
  [/(?<!\d)\d{15,19}(?!\d)/g, "[长数字]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, mask] of PII) out = out.replace(pattern, mask);
  return out;
}

export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

export function clampSummary(text: string): string {
  return clip(redact(text), TRACE_SUMMARY_MAX);
}

const INPUT_WHITELIST: Record<string, string[]> = {
  recall_memory: ["query", "dayKey", "place"],
  lookup_fact: ["entity", "question"],
  find_photos: ["aroundIso", "windowMin"],
};

export function summarizeToolInput(toolName: string, input: unknown): string {
  if (toolName.startsWith("submit_")) return "（交卷内容经守卫处理后见结果）";
  const keys = INPUT_WHITELIST[toolName] ?? [];
  const record = (input ?? {}) as Record<string, unknown>;
  const parts = keys
    .filter((key) => record[key] !== undefined && record[key] !== "")
    .map((key) => `${key}=${clip(redact(String(record[key])), FIELD_MAX)}`);
  return parts.length ? parts.join("，") : "无参数";
}

export function summarizeToolOutput(toolName: string, output: unknown): string {
  const record = (output ?? {}) as Record<string, unknown>;
  if (typeof record.error === "string") return `业务失败 ${record.error}`;
  switch (toolName) {
    case "recall_memory": {
      const lines = Array.isArray(record.lines) ? (record.lines as string[]) : [];
      const ids = lines.map((line) => line.split("|")[0]).slice(0, 4).join("、");
      return `命中 ${lines.length} 条${record.truncated ? "（已截断）" : ""}${ids ? `：${ids}` : ""}`;
    }
    case "lookup_fact":
      return `事实：${clip(redact(String(record.fact ?? "")), 60)}（AI 补充，未经核实）`;
    case "find_photos":
      return `找到 ${Array.isArray(record.photos) ? record.photos.length : 0} 张照片`;
    default:
      return toolName.startsWith("submit_") ? "已收卷" : "已返回";
  }
}
