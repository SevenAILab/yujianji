import type { HistoryEntry, RecognizeResult } from "./types";
import { recognizeResultSchema } from "./schema";
import { extractJsonObject } from "./json";
import { historyIds } from "./history";

export class RecognizeParseError extends Error {
  code: "INVALID_MODEL_OUTPUT" | "INVALID_RELATED_ITEM";

  constructor(
    code: "INVALID_MODEL_OUTPUT" | "INVALID_RELATED_ITEM",
    message: string,
  ) {
    super(message);
    this.name = "RecognizeParseError";
    this.code = code;
  }
}

export function parseRecognizeResult(
  raw: string,
  history: HistoryEntry[] | string,
): RecognizeResult {
  let value: unknown;
  try {
    value = extractJsonObject(raw);
  } catch (error) {
    throw new RecognizeParseError(
      "INVALID_MODEL_OUTPUT",
      error instanceof Error ? error.message : "模型 JSON 无法解析",
    );
  }

  const parsed = recognizeResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new RecognizeParseError("INVALID_MODEL_OUTPUT", "模型字段校验失败");
  }

  if (parsed.data.unrecognized) {
    return parsed.data;
  }

  if (parsed.data.verdict === "first" && parsed.data.relatedItemId !== null) {
    throw new RecognizeParseError(
      "INVALID_RELATED_ITEM",
      "初见结果不应包含关联记录",
    );
  }

  if (
    parsed.data.verdict === "reunion" &&
    (!parsed.data.relatedItemId || !historyIds(history).has(parsed.data.relatedItemId))
  ) {
    throw new RecognizeParseError(
      "INVALID_RELATED_ITEM",
      "模型返回了历史中不存在的关联 id",
    );
  }

  return {
    ...parsed.data,
    nameEn: parsed.data.nameEn ?? undefined,
  };
}
