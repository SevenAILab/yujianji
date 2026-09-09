import { describe, expect, it } from "vitest";
import {
  findFabricatedHistoryReference,
  parseRecognizeResult,
  RecognizeParseError,
} from "../src/lib/recognize";

/** 线上实测（2026-09-10, yujianji.vercel.app）传 history: [] 时模型的真实返回。 */
const realFabricatedLuck = {
  text: "你手里的这只白瓷杯，产自景德镇传统薄胎工艺作坊，最近一次出现在你记录里是去年冬至那场围炉煮茶。",
  basis:
    "杯型与釉色匹配2023年12月22日'围炉煮茶'记录中的同款器皿；但用户称'第一次见'，暂无法确认是否同一实物，故依据不充分",
  confidence: "low",
} satisfies Luck;

type Luck = { text: string; basis: string; confidence: "low" | "medium" | "high" };

function modelOutput(luck: Luck, memorySentence = "第一次遇见拉花碰杯，真巧。") {
  return JSON.stringify({
    name: "拉花咖啡杯",
    nameEn: "latte art cup",
    category: "artifact",
    cognition: "三只手举着杯子碰杯。",
    fun: "叶形拉花多用郁金香技法。",
    luck,
    question: "你是先看到拉花才点的吗？",
    verdict: "first",
    relatedItemId: null,
    memorySentence,
    unrecognized: false,
  });
}

describe("捏造过往的检测", () => {
  it("抓住线上真实出现过的那条捏造", () => {
    expect(
      findFabricatedHistoryReference([realFabricatedLuck.text, realFabricatedLuck.basis]),
    ).not.toBeNull();
  });

  it("逐类捏造都能抓住", () => {
    expect(findFabricatedHistoryReference(["最近一次出现在你记录里是去年冬至"])).not.toBeNull();
    expect(findFabricatedHistoryReference(["你之前见过一模一样的"])).not.toBeNull();
    expect(findFabricatedHistoryReference(["匹配2023年12月的记录"])).not.toBeNull();
    expect(findFabricatedHistoryReference(["上一次你遇见它是在杭州"])).not.toBeNull();
  });

  it("正常的初见文案不误伤", () => {
    expect(
      findFabricatedHistoryReference([
        "这是你的第一条这类记录。",
        "白瓷薄胎在灯下会透光，说明胎体做得很薄。",
        "第一次遇见拉花碰杯，真巧。",
        "这一件没有稀有度可讲。",
      ]),
    ).toBeNull();
  });

  it("空字段和缺失字段不报错", () => {
    expect(findFabricatedHistoryReference([null, undefined, ""])).toBeNull();
  });
});

describe("解析时拦截", () => {
  it("历史为空时，编造过往会被判为解析失败", () => {
    expect(() => parseRecognizeResult(modelOutput(realFabricatedLuck), [])).toThrowError(
      RecognizeParseError,
    );
    try {
      parseRecognizeResult(modelOutput(realFabricatedLuck), []);
    } catch (error) {
      expect((error as RecognizeParseError).code).toBe("FABRICATED_HISTORY");
    }
  });

  it("历史为空且文案干净时正常通过", () => {
    const clean = {
      text: "这只杯子的薄胎在灯下会透光，今天这个位置刚好有光。",
      basis: "薄胎瓷透光性依赖胎体厚度，属于可观察特征。",
      confidence: "medium",
    } satisfies Luck;
    const result = parseRecognizeResult(modelOutput(clean), []);
    expect(result.unrecognized).toBe(false);
    if (!result.unrecognized) expect(result.verdict).toBe("first");
  });

  it("历史非空时不做这项检查，避免误伤真实的重逢文案", () => {
    const history = [
      {
        id: "past-001",
        name: "白瓷杯",
        category: "artifact" as const,
        place: "景德镇",
        date: "2025-12-22T00:00:00Z",
        userNote: "围炉煮茶",
      },
    ];
    const result = parseRecognizeResult(modelOutput(realFabricatedLuck), history);
    expect(result.unrecognized).toBe(false);
  });
});
