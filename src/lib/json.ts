export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("模型没有返回 JSON 对象");
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的 JSON 无法解析");
  }
}
