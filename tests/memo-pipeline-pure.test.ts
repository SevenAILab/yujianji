import { describe, expect, it } from "vitest";
import { degradeFromQuotes, normalizeForMatch, stripFillers } from "../src/lib/memo/fillers";
import { rmsDb, speakerLoudness } from "../src/lib/memo/loudness";
import { placeAt } from "../src/lib/memo/place";
import { applySpeakerCorrection, assignSpeakerRoles } from "../src/lib/memo/speaker";
import { dayKeyIn, tzOffsetMinutes } from "../src/lib/memo/time";
import type { TimelineEvent, Utterance } from "../src/lib/memo/types";
import { chunkCount, chunkRange, pendingChunks } from "../src/lib/memo/upload-plan";
import { shouldSkipWithoutModel, splitWindows } from "../src/lib/memo/windows";

function utt(index: number, beginMs: number, endMs: number, speaker: Utterance["speaker"], text: string): Utterance {
  return { id: `s1:${index}`, sessionId: "s1", index, beginMs, endMs, speakerKey: speaker === "me" ? "0:1" : "0:0", speaker, text, expiresAt: "" };
}

describe("分块续传", () => {
  it("3MB 一块，按服务端已收到的块续传", () => {
    const size = 7 * 1024 * 1024 + 10;
    expect(chunkCount(size)).toBe(3);
    expect(chunkRange(2, size)).toEqual({ start: 6 * 1024 * 1024, end: size });
    expect(pendingChunks(3, [0, 2])).toEqual([1]);
    expect(pendingChunks(3, [])).toEqual([0, 1, 2]);
  });
});

describe("窗口切分", () => {
  it("停顿 ≥ 8 秒切窗口，并统计我和拿不准的字数", () => {
    const windows = splitWindows("s1", [
      utt(0, 0, 2000, "me", "接口明天几点对一下"),
      utt(1, 3000, 5000, "other", "上午十点吧"),
      utt(2, 14_000, 20_000, "me", "第一次见到这么多人穿成动漫角色出门"),
      utt(3, 21_000, 23_000, "uncertain", "好热闹"),
    ]);
    expect(windows.map((w) => w.utteranceIds)).toEqual([["s1:0", "s1:1"], ["s1:2", "s1:3"]]);
    expect(windows[1].meChars).toBe("第一次见到这么多人穿成动漫角色出门".length);
    expect(windows[1].uncertainChars).toBe(3);
  });

  it("累计超过 240 秒切窗口", () => {
    const list = Array.from({ length: 10 }, (_, i) => utt(i, i * 30_000, i * 30_000 + 29_000, "me", "说了一句话"));
    const windows = splitWindows("s1", list);
    expect(windows.length).toBe(2);
    expect(windows[0].endMs - windows[0].beginMs).toBeLessThanOrEqual(240_000);
  });

  it("累计超过 2500 字切窗口", () => {
    const long = "字".repeat(1_300);
    const windows = splitWindows("s1", [utt(0, 0, 1000, "me", long), utt(1, 1500, 2500, "me", long)]);
    expect(windows.length).toBe(2);
  });

  it("我（含拿不准）不到 15 字就不调模型", () => {
    expect(shouldSkipWithoutModel({ meChars: 5, uncertainChars: 5 })).toBe(true);
    expect(shouldSkipWithoutModel({ meChars: 5, uncertainChars: 12 })).toBe(false);
  });
});

describe("定我：说话人三态", () => {
  it("最响且领先 ≥ 3dB → me，其余 other", () => {
    const r = assignSpeakerRoles([
      { key: "0:0", meanDb: -29.6, talkMs: 9_000 },
      { key: "0:1", meanDb: -24.7, talkMs: 16_000 },
    ]);
    expect(r.speakers.find((s) => s.key === "0:1")?.role).toBe("me");
    expect(r.speakers.find((s) => s.key === "0:0")?.role).toBe("other");
    expect(r.meUncertain).toBe(false);
    expect(r.meSource).toBe("loudness");
  });

  it("差距 < 3dB → 前两名都是 uncertain，不猜", () => {
    const r = assignSpeakerRoles([
      { key: "0:0", meanDb: -25.0, talkMs: 9_000 },
      { key: "0:1", meanDb: -24.0, talkMs: 9_000 },
      { key: "0:2", meanDb: -40.0, talkMs: 2_000 },
    ]);
    expect(r.speakers.map((s) => s.role)).toEqual(["uncertain", "uncertain", "other"]);
    expect(r.meUncertain).toBe(true);
  });

  it("只有一个人说话 → me；响度算不出来 → 全部 uncertain", () => {
    expect(assignSpeakerRoles([{ key: "0:0", meanDb: -30, talkMs: 5_000 }]).speakers[0].role).toBe("me");
    const degraded = assignSpeakerRoles([
      { key: "0:0", meanDb: null, talkMs: 5_000 },
      { key: "0:1", meanDb: null, talkMs: 5_000 },
    ]);
    expect(degraded.speakers.every((s) => s.role === "uncertain")).toBe(true);
    expect(degraded.meSource).toBe("unavailable");
  });

  it("多分段各自判定（不同分段的 speakerId 不可比）", () => {
    const r = assignSpeakerRoles([
      { key: "0:0", meanDb: -20, talkMs: 1 },
      { key: "0:1", meanDb: -30, talkMs: 1 },
      { key: "1:0", meanDb: -31, talkMs: 1 },
      { key: "1:1", meanDb: -21, talkMs: 1 },
    ]);
    expect(r.speakers.filter((s) => s.role === "me").map((s) => s.key)).toEqual(["0:0", "1:1"]);
  });

  it("用户一键纠正后不再有 uncertain", () => {
    const corrected = applySpeakerCorrection(
      [
        { key: "0:0", meanDb: -25, talkMs: 1, role: "uncertain" },
        { key: "0:1", meanDb: -24, talkMs: 1, role: "uncertain" },
      ],
      ["0:0"],
    );
    expect(corrected.map((s) => s.role)).toEqual(["me", "other"]);
  });
});

describe("响度", () => {
  it("满幅正弦约 -3dB，静音算不出（null 以外的极小值）", () => {
    const sine = new Int16Array(8000).map((_, i) => Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
    expect(rmsDb(sine, 0, 8000)!).toBeCloseTo(-3, 0);
    expect(rmsDb(sine, 100, 100)).toBeNull();
  });

  it("按时长加权", () => {
    const loud = new Int16Array(16_000).fill(16_384);
    const result = speakerLoudness(loud, 8000, [
      { speakerKey: "0:0", beginMs: 0, endMs: 1000 },
      { speakerKey: "0:0", beginMs: 1000, endMs: 2000 },
    ]);
    expect(result[0].meanDb).toBeCloseTo(-6, 0);
    expect(result[0].talkMs).toBe(2000);
  });
});

describe("口水词", () => {
  it("去口水词并收拾标点", () => {
    expect(stripFillers("嗯，那个老爷爷，然后一个人坐在长椅上，啊")).toBe("老爷爷，一个人坐在长椅上");
    expect(normalizeForMatch("嗯，这个冰淇淋，是我吃过最好吃的！")).toBe("这个冰淇淋是我吃过最好吃的");
  });

  it("降级文本：去口水词后用句号连接，不增删实词", () => {
    expect(degradeFromQuotes(["嗯我突然觉得我们平时太着急了", "对对对，吃个饭都在看手机"])).toBe("我突然觉得我们平时太着急了。吃个饭都在看手机。");
  });
});

describe("时区与地点", () => {
  it("dayKey 按会话时区算：伦敦晚上 11 点不算到北京的第二天", () => {
    expect(dayKeyIn("2026-09-22T22:30:00Z", "Europe/London")).toBe("2026-09-22");
    expect(dayKeyIn("2026-09-22T22:30:00Z", "Asia/Shanghai")).toBe("2026-09-23");
    expect(tzOffsetMinutes("2026-09-22T12:00:00Z", "Asia/Shanghai")).toBe(480);
  });

  it("按句子时间找最近的定位事件；超过 30 分钟用会话地点；用户锁定的地点优先", () => {
    const events: TimelineEvent[] = [
      { id: "l1", kind: "location", startAt: "2026-09-22T06:00:00Z", refId: "", lat: 51.5, lng: -0.16, placeName: "伦敦 · 海德公园", source: "gps" },
      { id: "l2", kind: "location", startAt: "2026-09-22T07:00:00Z", refId: "", lat: 51.5, lng: -0.12, placeName: "伦敦 · 大本钟", source: "gps" },
    ];
    expect(placeAt(events, "2026-09-22T06:03:00Z")).toMatchObject({ name: "伦敦 · 海德公园", confidence: "high" });
    expect(placeAt(events, "2026-09-22T06:40:00Z")).toMatchObject({ name: "伦敦 · 大本钟", confidence: "medium" });
    expect(placeAt(events, "2026-09-22T09:00:00Z", { name: "伦敦", source: "manual" })).toMatchObject({ name: "伦敦", confidence: "low" });
    expect(placeAt(events, "2026-09-22T06:03:00Z", { name: "我确认的地点", source: "manual", locked: true })).toMatchObject({ name: "我确认的地点", confidence: "high" });
  });
});
