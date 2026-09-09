import type { HistoryEntry, RecognizeResult } from "./types";
import { recognizeResultSchema } from "./schema";
import { extractJsonObject } from "./json";
import { historyIds } from "./history";

export type RecognizeParseErrorCode =
  | "INVALID_MODEL_OUTPUT"
  | "INVALID_RELATED_ITEM"
  | "FABRICATED_HISTORY";

export class RecognizeParseError extends Error {
  code: RecognizeParseErrorCode;

  constructor(code: RecognizeParseErrorCode, message: string) {
    super(message);
    this.name = "RecognizeParseError";
    this.code = code;
  }
}

/**
 * 用户没有任何历史记录时，模型仍然会编出「去年冬至那场围炉煮茶」
 * 「2023年12月22日的同款器皿」这种过往。线上实测复现过：传 history: []，
 * luck 依然引用了一条根本不存在的记录。
 *
 * 「其实你见过」是这个产品的核心承诺，编出来的「见过」比不提更伤，
 * 所以这里在历史为空时做一次机械拦截 —— 这是高置信度场景：
 * 一条记录都没有，就不可能有任何「你上次」。
 *
 * 历史非空时不做检查：那需要逐条比对语义，误伤的代价比漏网更高。
 * 只查「关于用户」的字段；fun 讲的是世界知识，出现年份是正当的。
 */
const USER_PAST_REFERENCE = [
  // 「出现在你记录里」「你的收藏中」
  /(?:你|您)(?:的)?(?:记录|档案|收藏|藏品)(?:里|中|里面)/,
  // 「上一次…你」「去年…见过」
  /(?:上一次|上次|最近一次|之前|去年|前年|那年|当年)[^。；;！!]{0,14}(?:你|见过|遇见|记录|收藏)/,
  // 「你曾经见过」「你之前收藏过」
  /(?:你|您)(?:曾经|已经|之前|去年|上次)?(?:见过|遇见过|收藏过|记录过|拍过)/,
  // 这三个字段里出现具体年月，基本没有正当用途
  /\d{4}\s*年\s*\d{1,2}\s*月/,
];

export function findFabricatedHistoryReference(
  fields: Array<string | null | undefined>,
): string | null {
  for (const field of fields) {
    if (!field) continue;
    for (const pattern of USER_PAST_REFERENCE) {
      const hit = pattern.exec(field);
      if (hit) return hit[0];
    }
  }
  return null;
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

  if (historyIds(history).size === 0) {
    const fabricated = findFabricatedHistoryReference([
      parsed.data.luck.text,
      parsed.data.luck.basis,
      parsed.data.memorySentence,
    ]);
    if (fabricated) {
      throw new RecognizeParseError(
        "FABRICATED_HISTORY",
        `模型在没有历史记录时编造了过往：「${fabricated}」`,
      );
    }
  }

  return {
    ...parsed.data,
    nameEn: parsed.data.nameEn ?? undefined,
  };
}
