import { describe, expect, it } from "vitest";
import { checkParagraph, cnNumeralToNumber } from "../src/lib/memo/fidelity";
import { locateVerbatim, verifyQuotes } from "../src/lib/memo/quotes";
import { quotesForWriting, selectForDiary } from "../src/lib/memo/select";
import type { Moment } from "../src/lib/memo/types";

describe("确定性检查", () => {
  const source = { myQuotes: ["导游刚说这座桥修了三百年，现在每天还有车在上面跑，好 chill 的感觉。"] };

  it("升华黑名单：原话里没有就拦", () => {
    const issues = checkParagraph("导游说这座桥修了三百年，至今每天仍有车驶过。我终于明白，时间才是最好的建筑师。", source);
    expect(issues.map((i) => i.code)).toContain("SUBLIMATION");
  });

  it("数字：中文数字和阿拉伯数字互认，编出来的数字拦下", () => {
    expect(cnNumeralToNumber("三百")).toBe(300);
    expect(cnNumeralToNumber("两千零八")).toBe(2008);
    expect(checkParagraph("导游说这座桥修了 300 年，现在每天还有车在上面跑，很 chill。", source).map((i) => i.code)).not.toContain("UNGROUNDED_NUMBER");
    expect(checkParagraph("导游说这座桥修了 400 年，现在每天还有车在上面跑，很 chill。", source).map((i) => i.code)).toContain("UNGROUNDED_NUMBER");
  });

  it("英文词必须出现在原话里", () => {
    expect(checkParagraph("导游说这座桥修了三百年，现在每天还有车在上面跑，好 relax。", source).map((i) => i.code)).toContain("UNGROUNDED_LATIN");
  });

  it("引号里不是我的原话 → 拦下", () => {
    const issues = checkParagraph("朋友说“这桥比我年纪都大”，我觉得这座桥修了三百年，现在还有车跑，很 chill。", source);
    expect(issues.map((i) => i.code)).toContain("QUOTED_OTHERS");
  });

  it("原话很短时，长度下限跟着降，不逼模型凑字数", () => {
    expect(checkParagraph("这个冰淇淋，是我吃过最好吃的。", { myQuotes: ["这个冰淇淋是我吃过最好吃的。"] })).toEqual([]);
  });
});

describe("今日金句：逐字校验", () => {
  const sources = [
    { momentId: "m1", salience: 0.9, myQuotes: ["嗯，我突然觉得我们平时太着急了，吃个饭都在看手机。"] },
    { momentId: "m2", salience: 0.7, myQuotes: ["这个冰淇淋是我吃过最好吃的，有一点海盐的味道。"] },
  ];

  it("去口水词后逐字能找到 → 通过，显示原话里的那一段", () => {
    const r = verifyQuotes([{ momentId: "m1", text: "我突然觉得我们平时太着急了" }], sources);
    expect(r.quotes).toEqual([{ momentId: "m1", text: "我突然觉得我们平时太着急了" }]);
    expect(locateVerbatim("嗯 我突然觉得我们平时太着急了吃个饭都在看手机", sources[0].myQuotes)).toBe("我突然觉得我们平时太着急了，吃个饭都在看手机");
  });

  it("陷阱 1：调换语序 → 拦下", () => {
    expect(verifyQuotes([{ momentId: "m2", text: "这是我吃过最好吃的冰淇淋" }], sources).rejected[0].reason).toBe("NOT_VERBATIM");
  });

  it("陷阱 2：换近义词 → 拦下", () => {
    expect(verifyQuotes([{ momentId: "m1", text: "我忽然觉得我们平时太着急了" }], sources).rejected[0].reason).toBe("NOT_VERBATIM");
  });

  it("陷阱 3：润色加字 → 拦下", () => {
    expect(verifyQuotes([{ momentId: "m2", text: "这个冰淇淋是我吃过最好吃的，有一点淡淡的海盐味道" }], sources).rejected[0].reason).toBe("NOT_VERBATIM");
  });

  it("同一片段最多 1 条，长度 8–40 字，全部不合格时代码兜底取一句原话", () => {
    const r = verifyQuotes(
      [
        { momentId: "m1", text: "我突然觉得我们平时太着急了" },
        { momentId: "m1", text: "吃个饭都在看手机" },
        { momentId: "m2", text: "好吃" },
      ],
      sources,
    );
    expect(r.quotes).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["DUP_MOMENT", "LENGTH"]);
    const fallback = verifyQuotes([{ momentId: "m2", text: "编的" }], sources);
    expect(fallback.fallbackUsed).toBe(true);
    // 兜底和逐字路径一样：显示原话里的那一段，去掉句末的句号
    expect(fallback.quotes[0]).toEqual({ momentId: "m1", text: "我突然觉得我们平时太着急了，吃个饭都在看手机" });
  });
});

function moment(id: string, at: string, salience: number, partial: Partial<Moment> = {}): Moment {
  return {
    id, sessionId: "s", windowId: "w", dayKey: "2026-09-22", at, decision: "keep", salience, category: "reflection",
    trigger: "", why: "", myQuotes: ["原话"], sourceUtteranceIds: [], user: { copiedCount: 0 }, runId: "r", profileVersion: 1, createdAt: at,
    ...partial,
  };
}

describe("当日选段", () => {
  it("salience ≥ 0.5 的前 5 段；同一 15 分钟内最多 1 段（≥ 0.8 例外）；按时间排", () => {
    const list = [
      moment("a", "2026-09-22T06:00:00Z", 0.9),
      moment("b", "2026-09-22T06:05:00Z", 0.6), // 和 a 同一 15 分钟，被挤进折叠区
      moment("c", "2026-09-22T06:06:00Z", 0.85), // 同一 15 分钟，但 ≥ 0.8 例外
      moment("d", "2026-09-22T08:00:00Z", 0.4), // 低于 0.5
      moment("e", "2026-09-22T09:00:00Z", 0.9, { decision: "fold" }),
    ];
    const r = selectForDiary(list);
    expect(r.paragraphIds).toEqual(["a", "c"]);
    expect(r.foldedIds).toEqual(["b", "d", "e"]);
  });

  it("用户捞回的一定入选；用户删掉的哪里都不出现；拿不准说话人的不进正文", () => {
    const list = [
      moment("keep", "2026-09-22T06:00:00Z", 0.9),
      moment("restored", "2026-09-22T06:01:00Z", 0.2, { decision: "fold", user: { decision: "keep", copiedCount: 0 } }),
      moment("deleted", "2026-09-22T07:00:00Z", 0.95, { user: { decision: "drop", copiedCount: 0 } }),
      moment("uncertain", "2026-09-22T08:00:00Z", 0.9, { decision: "fold", speakerUncertain: true, myQuotes: [], uncertainQuotes: ["可能是我"] }),
    ];
    const r = selectForDiary(list);
    expect(r.paragraphIds).toEqual(["keep", "restored"]);
    expect(r.foldedIds).toEqual(["uncertain"]);
    expect(quotesForWriting({ myQuotes: [], uncertainQuotes: ["可能是我"], user: { copiedCount: 0, speakerConfirmed: true } })).toEqual(["可能是我"]);
  });
});
