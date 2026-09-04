import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/lib/json";
import { parseRecognizeResult, RecognizeParseError } from "../src/lib/recognize";
import { recognizeResultSchema } from "../src/lib/schema";
import type { HistoryEntry } from "../src/lib/types";

const history: HistoryEntry[] = [
  {
    id: "moganshan-pink-leaf-2025-10",
    name: "粉色叶子",
    category: "plant",
    place: "浙江 · 莫干山",
    date: "2025-10-12T16:32:00+08:00",
    userNote: "第一次见到粉色的叶子。",
  },
];

const success = {
  unrecognized: false,
  name: "粉色叶子",
  nameEn: "Pink leaf",
  category: "plant",
  cognition: "这是一片粉色叶片。",
  fun: "叶片颜色会随季节变化。",
  luck: {
    text: "你遇到了一种特别的颜色变化。",
    basis: "依据是照片中的叶色与季节环境。",
    confidence: "low",
  },
  question: "你是在什么时候发现它的？",
  verdict: "reunion",
  relatedItemId: "moganshan-pink-leaf-2025-10",
  memorySentence: "去年十月在莫干山，我们见过了。",
};

describe("extractJsonObject", () => {
  it("accepts plain JSON and explanatory text around JSON", () => {
    expect(extractJsonObject(JSON.stringify(success))).toEqual(success);
    expect(extractJsonObject(`模型结果如下：${JSON.stringify(success)}谢谢`)).toEqual(success);
  });

  it("extracts fenced JSON", () => {
    expect(extractJsonObject(`说明\\n\`\`\`json\\n${JSON.stringify(success)}\\n\`\`\``)).toEqual(success);
  });

  it("rejects invalid JSON", () => {
    expect(() => extractJsonObject("not json")).toThrow();
  });
});

describe("recognize result validation", () => {
  it("rejects missing fields, invalid categories, and oversized fields", () => {
    expect(recognizeResultSchema.safeParse({ ...success, fun: undefined }).success).toBe(false);
    expect(recognizeResultSchema.safeParse({ ...success, category: "unknown" }).success).toBe(false);
    expect(
      recognizeResultSchema.safeParse({
        ...success,
        cognition: "x".repeat(321),
      }).success,
    ).toBe(false);
  });

  it("accepts a valid reunion id", () => {
    expect(parseRecognizeResult(JSON.stringify(success), history)).toEqual(success);
  });

  it("rejects an invalid reunion id", () => {
    expect(() =>
      parseRecognizeResult(
        JSON.stringify({ ...success, relatedItemId: "missing" }),
        history,
      ),
    ).toThrowError(RecognizeParseError);
  });

  it("accepts an unrecognized union branch", () => {
    expect(
      parseRecognizeResult(
        JSON.stringify({
          unrecognized: true,
          name: null,
          nameEn: null,
          category: null,
          cognition: null,
          fun: null,
          luck: null,
          question: null,
          verdict: null,
          relatedItemId: null,
          memorySentence: null,
        }),
        history,
      ),
    ).toMatchObject({ unrecognized: true });
  });
});
