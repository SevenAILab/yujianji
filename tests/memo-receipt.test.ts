import { describe, expect, it } from "vitest";
import { diaryReceipt, receiptSentence } from "../src/lib/memo/receipt";
import type { DiaryParagraph } from "../src/lib/memo/types";

const paragraph = (momentId: string): DiaryParagraph => ({ momentId, heading: "", text: "段落", verified: true, degraded: false, retries: 0 });
const diary = (patch: Partial<{ paragraphs: DiaryParagraph[]; foldedMomentIds: string[]; profileVersion: number }> = {}) => ({
  paragraphs: [paragraph("m1"), paragraph("m2"), paragraph("m3")],
  foldedMomentIds: ["m4", "m5"],
  profileVersion: 1,
  generatedAt: "2026-09-23T15:40:00.000Z",
  ...patch,
});

describe("小遇的整理回执", () => {
  it("时长按会话去重求和，丢掉只算小遇的判断", () => {
    const r = diaryReceipt({
      diary: diary(),
      moments: [{ decision: "keep" }, { decision: "fold" }, { decision: "drop" }, { decision: "drop" }],
      sessions: [
        { id: "s1", durationSec: 1500 },
        { id: "s2", durationSec: 1320 },
        { id: "s1", durationSec: 1500 },
      ],
    });
    expect(r).toMatchObject({ minutes: 47, kept: 3, folded: 2, dropped: 2 });
    expect(receiptSentence(r, "小遇")).toBe("小遇从 47 分钟录音里留下 3 段，折叠 2 段，丢掉 2 段。");
  });

  it("为 0 的部分不说；不足 1 分钟照实说", () => {
    const r = diaryReceipt({ diary: diary({ foldedMomentIds: [] }), moments: [{ decision: "keep" }], sessions: [{ id: "s1", durationSec: 45 }] });
    expect(receiptSentence(r, "小遇")).toBe("小遇从不到 1 分钟的录音里留下 3 段。");
  });

  it("没有录音的纯照片日不编时长", () => {
    const r = diaryReceipt({ diary: diary({ paragraphs: [], foldedMomentIds: [] }), moments: [], sessions: [] });
    expect(r.minutes).toBeNull();
    expect(receiptSentence(r, "小遇")).toBe("小遇把这天的照片按时间排好了。");
  });
});
