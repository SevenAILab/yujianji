import { describe, expect, it } from "vitest";
import { buildDiaryTimeline, diaryCoverItemId } from "../src/lib/memo/timeline";
import type { Item } from "../src/lib/types";
import type { DiaryParagraph, Moment } from "../src/lib/memo/types";

const DAY = "2026-09-23";
const TZ = "Asia/Shanghai";
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 23, hour - 8, minute)).toISOString();

const moment = (id: string, when: string, patch: Partial<Moment> = {}): Moment =>
  ({ id, sessionId: "s1", windowId: "w1", dayKey: DAY, at: when, decision: "keep", salience: 0.7, category: "observation", trigger: "", why: "", myQuotes: ["原话"], sourceUtteranceIds: [], user: { copiedCount: 0 }, runId: "r", profileVersion: 1, createdAt: when, ...patch }) as Moment;
const paragraph = (momentId: string): DiaryParagraph => ({ momentId, heading: "", text: "段落", verified: true, degraded: false, retries: 0 });
const item = (id: string, when: string, patch: Partial<Item> = {}) =>
  ({ id, name: `物件${id}`, place: "深圳", date: when, isSeed: false, ai: { verdict: "first" }, ...patch }) as unknown as Item;

describe("手帐时间线", () => {
  it("纯照片日：只有照片条目，按时间排", () => {
    const t = buildDiaryTimeline({ dayKey: DAY, paragraphs: [], moments: [], items: [item("b", at(15)), item("a", at(9))], timeZone: TZ });
    expect(t.map((e) => (e.kind === "photo" ? e.itemId : e.momentId))).toEqual(["a", "b"]);
  });

  it("纯录音日：只有段落", () => {
    const t = buildDiaryTimeline({ dayKey: DAY, paragraphs: [paragraph("m1")], moments: [moment("m1", at(10))], items: [], timeZone: TZ });
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe("moment");
  });

  it("混合日：段落和照片按时间交错；被段落用掉的照片不重复出现", () => {
    const t = buildDiaryTimeline({
      dayKey: DAY,
      paragraphs: [paragraph("m1"), paragraph("m2")],
      moments: [moment("m1", at(10), { photoId: "used" }), moment("m2", at(16))],
      items: [item("used", at(10, 1)), item("free", at(12))],
      timeZone: TZ,
    });
    expect(t.map((e) => (e.kind === "photo" ? `p:${e.itemId}` : `m:${e.momentId}`))).toEqual(["m:m1", "p:free", "m:m2"]);
    expect(t[0].kind === "moment" && t[0].photoId).toBe("used");
  });

  it("识别没完成、重逢、示例、别的日子的照片都不进时间线", () => {
    const t = buildDiaryTimeline({
      dayKey: DAY,
      paragraphs: [],
      moments: [],
      items: [
        item("pending", at(9), { ai: null }),
        item("reunion", at(9), { ai: { verdict: "reunion" } as Item["ai"] }),
        item("seed", at(9), { isSeed: true }),
        item("yesterday", "2026-09-22T04:00:00.000Z"),
        item("ok", at(9)),
      ],
      timeZone: TZ,
    });
    expect(t.map((e) => (e.kind === "photo" ? e.itemId : ""))).toEqual(["ok"]);
  });

  it("折叠片段占用的照片仍作为独立照片条目出现", () => {
    const t = buildDiaryTimeline({
      dayKey: DAY,
      paragraphs: [paragraph("visible")],
      moments: [
        moment("visible", at(10), { photoId: "visible-photo" }),
        moment("folded", at(11), { photoId: "folded-photo", decision: "fold" }),
      ],
      items: [item("visible-photo", at(10)), item("folded-photo", at(11))],
      timeZone: TZ,
    });
    expect(t.map((entry) => (entry.kind === "photo" ? entry.itemId : entry.momentId))).toEqual(["visible", "folded-photo"]);
  });

  it("封面：第一张配图优先，其次第一张照片条目", () => {
    const mixed = buildDiaryTimeline({
      dayKey: DAY,
      paragraphs: [paragraph("m1")],
      moments: [moment("m1", at(15), { photoId: "cover" })],
      items: [item("cover", at(15)), item("early", at(9))],
      timeZone: TZ,
    });
    expect(diaryCoverItemId(mixed)).toBe("cover");
    const photoOnly = buildDiaryTimeline({ dayKey: DAY, paragraphs: [], moments: [], items: [item("x", at(9))], timeZone: TZ });
    expect(diaryCoverItemId(photoOnly)).toBe("x");
    expect(diaryCoverItemId([])).toBeUndefined();
  });
});
