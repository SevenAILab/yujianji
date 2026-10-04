// 以声定图的确定性候选（外部设备接入工单 v2 Gate 2）
import { describe, expect, it } from "vitest";
import { momentsNeedingPhoto, selectAssetCandidates, usedAssetIds, type AssetLite } from "@/lib/memo/asset-match";
import type { Moment } from "@/lib/memo/types";

const T = "2026-10-02T09:00:00.000Z";
const at = (offsetSec: number) => new Date(Date.parse(T) + offsetSec * 1000).toISOString();
const asset = (id: string, offsetSec: number | null, status: AssetLite["status"] = "pooled"): AssetLite => ({
  id,
  capturedAt: offsetSec === null ? null : at(offsetSec),
  source: "phone",
  status,
});

describe("时间窗", () => {
  it("T−120s 进、T−121s 不进；T+60s 进、T+61s 不进", () => {
    const r = selectAssetCandidates(T, [asset("a", -121), asset("b", -120), asset("c", 60), asset("d", 61)]);
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["b", "c"]);
    expect(r.inWindow).toBe(2);
    expect(r.nearestOutside).toEqual({ id: "d", deltaMs: 61_000 });
  });

  it("窗口外的照片永远不进候选（哪怕窗口里一张都没有）", () => {
    const r = selectAssetCandidates(T, [asset("far", -600), asset("late", 300)]);
    expect(r.candidates).toEqual([]);
    expect(r.inWindow).toBe(0);
    expect(r.nearestOutside?.id).toBe("late");
  });

  it("窗口可配置", () => {
    const r = selectAssetCandidates(T, [asset("a", -200)], { window: { beforeMs: 300_000 } });
    expect(r.candidates.map((c) => c.id)).toEqual(["a"]);
  });

  it("拍摄时间未知、识别失败过、已用过的不参与", () => {
    const r = selectAssetCandidates(T, [asset("unknown", null), asset("bad", 5, "unrecognized"), asset("used", 3), asset("ok", 10)], { exclude: new Set(["used"]) });
    expect(r.candidates.map((c) => c.id)).toEqual(["ok"]);
  });
});

describe("名额与让位", () => {
  it("按离 T 的距离排，最多 3 张", () => {
    const r = selectAssetCandidates(T, [asset("a", -100), asset("b", -50), asset("c", 20), asset("d", 40), asset("e", -10)]);
    expect(r.candidates.map((c) => c.id)).toEqual(["e", "c", "d"]);
    expect(r.inWindow).toBe(5);
  });

  it("3 秒内的连拍在名额上让位，但不删除：名额够时照样补上", () => {
    // a、b 只差 1 秒；c 在 30 秒外
    const crowded = selectAssetCandidates(T, [asset("a", 0), asset("b", 1), asset("c", 30), asset("d", 50)]);
    expect(crowded.candidates.map((c) => c.id)).toEqual(["a", "c", "d"]);
    const roomy = selectAssetCandidates(T, [asset("a", 0), asset("b", 1), asset("c", 30)]);
    expect(roomy.candidates.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("哪些片段要配图", () => {
  const base = (over: Partial<Moment>): Moment =>
    ({
      id: "m",
      sessionId: "s",
      windowId: "w",
      dayKey: "2026-10-02",
      at: T,
      decision: "keep",
      salience: 0.5,
      category: "observation",
      trigger: "",
      why: "",
      myQuotes: ["这个塔好高"],
      sourceUtteranceIds: [],
      user: { copiedCount: 0 },
      runId: "r",
      profileVersion: 1,
      createdAt: T,
      ...over,
    }) as Moment;

  it("只要留下的、讲眼前东西的、还没图的、有我的原话的；按显著度排", () => {
    const list = momentsNeedingPhoto(
      [
        base({ id: "low", salience: 0.3 }),
        base({ id: "high", salience: 0.9 }),
        base({ id: "hasPhoto", photoId: "item1" }),
        base({ id: "memory", category: "memory" }),
        base({ id: "folded", decision: "fold" }),
        base({ id: "noQuote", myQuotes: [] }),
        base({ id: "otherDay", dayKey: "2026-10-03" }),
      ],
      "2026-10-02",
    );
    expect(list.map((m) => m.id)).toEqual(["high", "low"]);
  });

  it("用过的素材按片段的 assetId 推出来", () => {
    expect([...usedAssetIds([{ assetId: "a1" }, {}, { assetId: "a2" }])]).toEqual(["a1", "a2"]);
  });
});
