import { extractJsonObject } from "./json";
import { avModelResultSchema } from "./schema";
import type { AvResult, HistoryEntry } from "./types";

export class AvParseError extends Error {
  code: "INVALID_MODEL_OUTPUT" | "INVALID_RELATED_ITEM";

  constructor(
    code: "INVALID_MODEL_OUTPUT" | "INVALID_RELATED_ITEM",
    message: string,
  ) {
    super(message);
    this.name = "AvParseError";
    this.code = code;
  }
}

export type AvReunionExpectation = {
  frameIndex: number;
  category: string;
  relatedItemId: string;
  relatedItemName: string;
};

export function extractAvReunionExpectations(
  raw: string,
): AvReunionExpectation[] {
  let value: unknown;
  try {
    value = extractJsonObject(raw);
  } catch {
    return [];
  }
  const parsed = avModelResultSchema.safeParse(value);
  if (!parsed.success || !parsed.data.recognized) return [];
  return parsed.data.segments
    .filter((segment) => segment.verdict === "reunion")
    .map((segment) => ({
      frameIndex: segment.frameIndex,
      category: segment.category,
      relatedItemId: segment.relatedItemId as string,
      relatedItemName: segment.relatedItemName as string,
    }));
}

export function assertReunionPreserved(
  result: AvResult,
  expectations: AvReunionExpectation[],
): void {
  if (!expectations.length) return;
  if (!result.recognized) {
    throw new AvParseError(
      "INVALID_RELATED_ITEM",
      "重试结果丢失了需要确认的重逢",
    );
  }
  for (const expectation of expectations) {
    const matchingSegment = result.segments.find(
      (segment) =>
        segment.frameIndex === expectation.frameIndex &&
        segment.category === expectation.category &&
        segment.relatedItemId === expectation.relatedItemId &&
        segment.relatedItemName === expectation.relatedItemName,
    );
    if (!matchingSegment || matchingSegment.verdict !== "reunion") {
      throw new AvParseError(
        "INVALID_RELATED_ITEM",
        "重试结果不能静默改变重逢判定",
      );
    }
  }
}

export function parseAvResult(
  raw: string,
  history: HistoryEntry[],
  frameCount: number,
): AvResult {
  let value: unknown;
  try {
    value = extractJsonObject(raw);
  } catch {
    throw new AvParseError("INVALID_MODEL_OUTPUT", "模型 JSON 无法解析");
  }

  const parsed = avModelResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new AvParseError("INVALID_MODEL_OUTPUT", "模型字段校验失败");
  }
  if (!parsed.data.recognized) return parsed.data;

  const historyById = new Map(history.map((entry) => [entry.id, entry]));
  const segments = parsed.data.segments.map((segment) => {
    if (segment.frameIndex >= frameCount) {
      throw new AvParseError("INVALID_MODEL_OUTPUT", "模型返回了不存在的画面帧");
    }

    if (segment.verdict === "first") {
      if (segment.relatedItemId !== null || segment.relatedItemName !== null) {
        throw new AvParseError(
          "INVALID_RELATED_ITEM",
          "初见结果不应包含历史关联",
        );
      }
      return {
        ...segment,
        nameEn: segment.nameEn ?? undefined,
        associationStatus: "none" as const,
      };
    }

    if (!segment.relatedItemId) {
      throw new AvParseError("INVALID_RELATED_ITEM", "重逢结果缺少历史 id");
    }
    const related = historyById.get(segment.relatedItemId);
    if (
      !related ||
      related.category !== segment.category ||
      segment.relatedItemName !== related.name
    ) {
      throw new AvParseError(
        "INVALID_RELATED_ITEM",
        "模型返回的历史关联不一致",
      );
    }

    return {
      ...segment,
      nameEn: segment.nameEn ?? undefined,
      relatedItemName: related.name,
      associationStatus:
        segment.matchConfidence === "high" ? ("confirmed" as const) : ("uncertain" as const),
    };
  });

  return {
    recognized: true,
    placeHint: parsed.data.placeHint,
    segments,
  };
}
