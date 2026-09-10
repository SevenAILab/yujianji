import { describe, expect, it } from "vitest";
import { describeRawShape, extractJsonObject } from "../src/lib/json";
import { parseReplyResult, ReplyValidationError, salvageReply } from "../src/lib/reply";
import { cleanSummary } from "../src/lib/summary";

describe("坏 JSON 的确定性修复（agnes-2.5-flash 实测会出现）", () => {
  it("中文正文里的英文双引号", () => {
    const raw = '{"name": "拿铁", "fun": "它在意大利被称为"caffè latte"，意思是牛奶咖啡。"}';
    expect(extractJsonObject(raw)).toEqual({
      name: "拿铁",
      fun: '它在意大利被称为"caffè latte"，意思是牛奶咖啡。',
    });
  });

  it("字符串里夹了真实换行", () => {
    const raw = '{"cognition": "第一行\n第二行", "verdict": "first"}';
    expect(extractJsonObject(raw)).toEqual({ cognition: "第一行\n第二行", verdict: "first" });
  });

  it("末尾多逗号", () => {
    expect(extractJsonObject('{"a": [1, 2,], "b": "x",}')).toEqual({ a: [1, 2], b: "x" });
  });

  it("包在代码块里、前后有解释文字", () => {
    expect(extractJsonObject('好的，结果如下：\n```json\n{"ok": true}\n```\n希望有帮助')).toEqual({ ok: true });
  });

  it("截断的 JSON 修不了，照常报错交给上层重试", () => {
    expect(() => extractJsonObject('{"name": "拿铁", "luck": {"text": "三杯咖啡')).toThrow();
  });

  it("正常 JSON 原样通过", () => {
    expect(extractJsonObject('{"a": "含\\"转义\\"的引号"}')).toEqual({ a: '含"转义"的引号' });
  });

  it("日志形状不含原文", () => {
    const raw = '{"userNote": "我的原话", "x": 1';
    const shape = describeRawShape(raw);
    expect(shape).toEqual({ length: raw.length, balancedBraces: false, endsWithBrace: false, fenced: false });
    expect(JSON.stringify(shape)).not.toContain("原话");
  });
});

describe("回应：先收句，再决定要不要重试", () => {
  it("「顺便一提」没超 45 字时原样保留 —— 只管契约，不改风格", () => {
    const reply = "它挑了地方也挑了你。顺便一提，虎斑是家猫最常见的毛色。";
    expect(parseReplyResult(JSON.stringify({ reply }))).toBe(reply);
  });

  it("「顺便一提」拖到超长时，收成第一句", () => {
    const raw = JSON.stringify({
      reply:
        "它挑了地方也挑了你。顺便一提，虎斑是所有家猫里最常见的毛色模式，据说几乎每三只家猫里就有一只是这种花纹，而且大多性格亲人。",
    });
    expect(parseReplyResult(raw)).toBe("它挑了地方也挑了你。");
  });

  it("结尾补了一个问题，去掉那一句", () => {
    const raw = JSON.stringify({ reply: "你说腿麻，看来这片叶子确实值得。后来你还回去看过吗？" });
    expect(parseReplyResult(raw)).toBe("你说腿麻，看来这片叶子确实值得。");
  });

  it("第二句夹英文，只保留第一句", () => {
    expect(salvageReply("它选中了最软的位置。这叫 cat nap 姿势。")).toBe("它选中了最软的位置。");
  });

  it("整句都不合格时抛出带原因的错误，让路由重试", () => {
    try {
      parseReplyResult(JSON.stringify({ reply: "你当时蹲了多久？" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReplyValidationError);
      expect((error as ReplyValidationError).reason).toBe("question");
    }
    try {
      parseReplyResult("完全不是 JSON");
      expect.unreachable();
    } catch (error) {
      expect((error as ReplyValidationError).reason).toBe("parse");
    }
  });

  it("合格的回应一个字不改", () => {
    expect(parseReplyResult(JSON.stringify({ reply: "它自己选了你，这说明它对你满意。" }))).toBe(
      "它自己选了你，这说明它对你满意。",
    );
  });
});

describe("总结：绝不把 JSON 给用户看", () => {
  it("线上实测的 JSON 对象，取出正文", () => {
    const raw = '{\n  "route": [{"point": "北京", "object": "银杏叶"}],\n  "summary": "秋天在北京踩过满地银杏，冬至在杭州喝了一杯拉花。"\n}';
    expect(cleanSummary(raw)).toBe("秋天在北京踩过满地银杏，冬至在杭州喝了一杯拉花。");
  });

  it("对象里没有正文字段，返回空串让路由报错", () => {
    expect(cleanSummary('{"route": [{"point": "北京"}]}')).toBe("");
  });

  it("截断的 JSON，返回空串而不是半截乱码", () => {
    expect(cleanSummary('{"route": [], "summary": "秋天')).toBe("");
  });

  it("超长时在句号处收尾", () => {
    const text = `${"甲".repeat(100)}。${"乙".repeat(80)}。`;
    expect(cleanSummary(text)).toBe(`${"甲".repeat(100)}。`);
  });

  it("普通正文照常清理引号", () => {
    expect(cleanSummary("“这趟旅程还只留下了一两个线索。”")).toBe("这趟旅程还只留下了一两个线索。");
  });
});
