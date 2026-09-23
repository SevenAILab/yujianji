import { describe, expect, it } from "vitest";
import { buildUniverseNodes, isSameOriginPath, parseManifest, ringSlots, sampleNodes } from "../src/lib/universe/nodes";
import type { Item } from "../src/lib/types";
import type { Moment } from "../src/lib/memo/types";

const TZ = "Asia/Shanghai";
const item = (id: string, date: string, patch: Partial<Item> = {}) =>
  ({ id, name: `物件${id}`, date, isSeed: false, ai: { verdict: "first" }, ...patch }) as unknown as Item;

describe("记忆宇宙 · 圈层", () => {
  it("第 1 圈 5 个，满了开新圈，每圈多 3 个", () => {
    const slots = ringSlots(14);
    expect(slots.filter((s) => s.ring === 0)).toHaveLength(5);
    expect(slots.filter((s) => s.ring === 1)).toHaveLength(8);
    expect(slots.filter((s) => s.ring === 2)).toHaveLength(1);
  });

  it("最外圈没填满时按实际个数均分", () => {
    const slots = ringSlots(7);
    expect(slots.filter((s) => s.ring === 1).every((s) => s.size === 2)).toBe(true);
    expect(slots.filter((s) => s.ring === 0).every((s) => s.size === 5)).toBe(true);
  });

  it("没有节点就没有圈", () => {
    expect(ringSlots(0)).toEqual([]);
  });
});

describe("记忆宇宙 · 模型清单容错", () => {
  it("只收站内相对路径", () => {
    expect(isSameOriginPath("/assets/models/a.glb")).toBe(true);
    expect(isSameOriginPath("//evil.com/a.glb")).toBe(false);
    expect(isSameOriginPath("https://evil.com/a.glb")).toBe(false);
    expect(isSameOriginPath("assets/a.glb")).toBe(false);
    expect(isSameOriginPath(42)).toBe(false);
  });

  it("损坏的清单、非法字段都当作没有模型", () => {
    expect(parseManifest(null).size).toBe(0);
    expect(parseManifest("garbage").size).toBe(0);
    expect(parseManifest([1, 2]).size).toBe(0);
    const m = parseManifest({
      ok: { glbUrl: "/assets/models/ok.glb", bbox: [1, 0.5, 0.4], color: "#AABBCC" },
      external: { glbUrl: "https://x.com/a.glb" },
      badBox: { glbUrl: "/assets/models/b.glb", bbox: [1, -1, "x"], color: "red" },
      noUrl: { bbox: [1, 1, 1] },
    });
    expect([...m.keys()].sort()).toEqual(["badBox", "ok"]);
    expect(m.get("badBox")).toEqual({ glbUrl: "/assets/models/b.glb" });
    expect(m.get("ok")?.color).toBe("#AABBCC");
  });
});

describe("记忆宇宙 · 节点", () => {
  it("只要初见，按时间从早到晚；点了跳到那天配图的段落，没配到就跳照片条目", () => {
    const moments = [{ id: "m1", at: "2026-09-22T02:00:00.000Z", salience: 0.8, decision: "keep", photoId: "b", user: { copiedCount: 0 } }] as unknown as Moment[];
    const nodes = buildUniverseNodes({
      items: [
        item("c", "2026-09-23T02:00:00.000Z"),
        item("a", "2026-09-21T02:00:00.000Z"),
        item("b", "2026-09-22T02:05:00.000Z"),
        item("pending", "2026-09-22T02:00:00.000Z", { ai: null }),
        item("reunion", "2026-09-22T02:00:00.000Z", { ai: { verdict: "reunion" } as Item["ai"] }),
        item("seed", "2026-09-22T02:00:00.000Z", { isSeed: true }),
      ],
      moments,
      manifest: parseManifest({ a: { glbUrl: "/assets/models/a.glb", color: "#112233" }, deleted: { glbUrl: "/assets/models/x.glb" } }),
      timeZone: TZ,
    });
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(nodes[1].href).toBe("/memo/day/2026-09-22#m-m1");
    expect(nodes[0].href).toBe("/memo/day/2026-09-21#p-a");
    expect(nodes[0].model?.glbUrl).toBe("/assets/models/a.glb");
    expect(nodes[0].color).toBe("#112233");
    expect(nodes[2].model).toBeUndefined();
  });

  it("示例节点不可点", () => {
    const nodes = sampleNodes([{ id: "x", label: "玄武岩", capturedAt: "2024-08-20T10:18:00+08:00", color: "#2B2B30" }, { bad: true }]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sample).toBe(true);
    expect(nodes[0].href).toBeUndefined();
  });
});
