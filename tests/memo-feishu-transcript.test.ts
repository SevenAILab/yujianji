// 飞书文字记录解析（外部设备接入工单 v2 Gate 1）。夹具是按真实格式手写的脱敏文本，不含真实对话。
import { describe, expect, it } from "vitest";
import {
  localClock,
  ownerSpeakerKeys,
  parseRecordingTime,
  parseVerbatim,
  speakerIdFor,
  splitSentences,
  turnsToSentences,
} from "@/lib/memo/feishu-transcript";

const RAW = `文字记录：测试散步 2026年10月2日

录音主题：测试散步
录音时间：2026年10月2日（周五） 16:52 - 18:04 （GMT+08）
智能纪要：测试散步 2026年10月2日

说话人 1 00:00:01
你点了？

@seven 00:00:02
点了。这个塔好高啊！第一次见到这种颜色的砖。

说话人 1 00:00:10
走吧，前面还要排队。

@Seven 00:01:00
记一下，
这里的风是咸的。
`;

describe("录音时间", () => {
  it("从「录音时间」行读出开录、结束和时区", () => {
    const t = parseRecordingTime(RAW)!;
    expect(t.startedAt).toBe("2026-10-02T08:52:00.000Z");
    expect(t.endedAt).toBe("2026-10-02T10:04:00.000Z");
    expect(t.tzOffsetMin).toBe(480);
    expect(localClock(t.startedAt, t.tzOffsetMin)).toBe("16:52");
  });

  it("跨零点：结束早于开始算第二天", () => {
    const t = parseRecordingTime("录音时间：2026年9月30日（周三） 23:40 - 00:20 （GMT+08）")!;
    expect(t.startedAt).toBe("2026-09-30T15:40:00.000Z");
    expect(t.endedAt).toBe("2026-09-30T16:20:00.000Z");
  });

  it("带结束日期、其他时区", () => {
    const t = parseRecordingTime("录音时间：2026年10月5日（周一） 23:50 - 2026年10月6日（周二） 00:10 （GMT+01:00）")!;
    expect(t.startedAt).toBe("2026-10-05T22:50:00.000Z");
    expect(t.endedAt).toBe("2026-10-05T23:10:00.000Z");
    expect(t.tzOffsetMin).toBe(60);
  });

  it("读不到就返回 null（交给用户确认）", () => {
    expect(parseRecordingTime("文字记录：没有时间")).toBeNull();
    expect(parseRecordingTime("录音时间：2026年13月2日（周五） 16:52 - 18:04 （GMT+08）")).toBeNull();
  });
});

describe("分段", () => {
  it("段落头、说话人、正文；头部几行不当成段落", () => {
    const { turns } = parseVerbatim(RAW);
    expect(turns.map((t) => [t.label, t.speakerId, t.named, t.beginMs])).toEqual([
      ["说话人 1", "s1", false, 1_000],
      ["@seven", "u_seven", true, 2_000],
      ["说话人 1", "s1", false, 10_000],
      ["@Seven", "u_seven", true, 60_000],
    ]);
    expect(turns[3].text).toBe("记一下，这里的风是咸的。");
  });

  it("中文名的说话人 id 稳定、不含分隔符", () => {
    const a = speakerIdFor("@张三");
    expect(a.named).toBe(true);
    expect(a.speakerId).toMatch(/^u_[a-z0-9]+$/);
    expect(speakerIdFor("@张三").speakerId).toBe(a.speakerId);
    expect(speakerIdFor("说话人 12")).toEqual({ speakerId: "s12", named: false });
  });

  it("切句：句末标点切开，碎句并回前句", () => {
    expect(splitSentences("点了。这个塔好高啊！第一次见到这种颜色的砖。")).toEqual(["点了。", "这个塔好高啊！", "第一次见到这种颜色的砖。"]);
    expect(splitSentences("好。。")).toEqual(["好。。"]);
  });
});

describe("句子时间轴", () => {
  it("段尾 = 下一段开头，最后一段到音频时长；总长和音频时长一致", () => {
    const { turns } = parseVerbatim(RAW);
    const sentences = turnsToSentences(turns, 72_000);
    expect(sentences[0]).toMatchObject({ beginMs: 1_000, endMs: 2_000, speakerKey: "0:s1" });
    const second = sentences.filter((s) => s.speakerId === "u_seven" && s.beginMs < 10_000);
    expect(second.length).toBe(3);
    expect(second[0].beginMs).toBe(2_000);
    expect(second.at(-1)!.endMs).toBe(10_000);
    for (let i = 1; i < second.length; i += 1) expect(second[i].beginMs).toBe(second[i - 1].endMs);
    expect(sentences.at(-1)!.endMs).toBe(72_000);
    for (const s of sentences) expect(s.endMs).toBeGreaterThan(s.beginMs);
  });

  it("拿不到时长时最后一段按字数估", () => {
    const sentences = turnsToSentences([{ label: "说话人 1", speakerId: "s1", named: false, beginMs: 5_000, text: "一二三四" }], null);
    expect(sentences).toEqual([{ beginMs: 5_000, endMs: 6_000, speakerId: "s1", speakerKey: "0:s1", text: "一二三四", partIndex: 0 }]);
  });
});

describe("定我", () => {
  it("和授权用户同名的 @ 说话人算我，大小写不敏感；名字对不上不猜", () => {
    const { turns } = parseVerbatim(RAW);
    expect(ownerSpeakerKeys(turns, ["Seven"])).toEqual(["0:u_seven"]);
    expect(ownerSpeakerKeys(turns, ["别人"])).toEqual([]);
    expect(ownerSpeakerKeys(turns, [])).toEqual([]);
  });
});
