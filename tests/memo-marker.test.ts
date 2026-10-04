// 口令标记（外部设备接入工单 v2 Gate 1）
import { describe, expect, it } from "vitest";
import { hasMarker, stripMarker, windowHasMarker } from "@/lib/memo/marker";
import { applyGuards } from "@/lib/memo/guards";

describe("口令", () => {
  it("只认明确的说法", () => {
    expect(hasMarker("记一下，这里的风是咸的")).toBe(true);
    expect(hasMarker("小遇，这是什么")).toBe(true);
    expect(hasMarker("帮我记住这个味道")).toBe(true);
    expect(hasMarker("留下来吃饭吧")).toBe(false);
    expect(hasMarker("我们走吧")).toBe(false);
  });

  it("句首、句尾的口令从原话里去掉，中间的保留", () => {
    expect(stripMarker("小遇，记一下：这里的风是咸的。")).toBe("这里的风是咸的。");
    expect(stripMarker("这里的风是咸的，记一下。")).toBe("这里的风是咸的");
    expect(stripMarker("记一下")).toBe("");
    expect(stripMarker("我想让小遇也看看")).toBe("我想让小遇也看看");
  });

  it("别人说的口令不算", () => {
    expect(windowHasMarker([{ speaker: "other", text: "记一下" }])).toBe(false);
    expect(windowHasMarker([{ speaker: "me", text: "记一下这个" }])).toBe(true);
    expect(windowHasMarker([{ speaker: "uncertain", text: "小遇你看" }])).toBe(true);
  });

  it("守卫产出的原话里没有口令；只说了口令的那句不留空串", () => {
    const { moments } = applyGuards(
      [
        {
          decision: "keep",
          salience: 0.8,
          category: "observation",
          trigger: "风是咸的",
          why: "第一次闻到海风",
          sourceUtteranceIds: ["u1", "u2"],
          speakerUncertain: false,
        } as never,
      ],
      {
        mode: "session",
        utterances: [
          { id: "u1", speaker: "me", text: "记一下。" },
          { id: "u2", speaker: "me", text: "这里的风是咸的，好像能尝到海。" },
        ],
      },
    );
    expect(moments[0]?.myQuotes).toEqual(["这里的风是咸的，好像能尝到海。"]);
  });
});
