import { describe, expect, it } from "vitest";
import {
  buildInsightPool,
  pickInsightFact,
  type InsightFact,
} from "../src/lib/insight";
import type { Category, Item } from "../src/lib/types";

function makeItem(
  id: string,
  name: string,
  place: string,
  country: string,
  date: string,
  category: Category = "plant",
): Item {
  return {
    id,
    name,
    category,
    photo: "",
    place,
    country,
    lat: 30,
    lng: 120,
    locationSource: "manual",
    date,
    userNote: "",
    ai: null,
    isSeed: true,
    createdAt: date,
  };
}

const items: Item[] = [
  makeItem("i1", "粉色叶子", "浙江 · 莫干山", "CHN", "2025-10-12T16:32:00+08:00"),
  makeItem("i2", "玄武岩", "青海 · 茶卡", "CHN", "2024-08-03T09:10:00+08:00", "mineral"),
  makeItem("i3", "崖边灯塔", "英国 · 七姐妹白崖", "GBR", "2022-10-30T11:00:00+00:00", "landscape"),
  makeItem("i4", "远山薄雾", "浙江 · 天目山", "CHN", "2022-04-18T08:00:00+08:00", "landscape"),
  makeItem("i5", "雪线公路", "奥地利 · 大钟山", "AUT", "2023-07-09T14:20:00+02:00", "landscape"),
  makeItem("i6", "白瓷咖啡杯", "日本 · 京都", "JPN", "2021-04-02T10:00:00+09:00", "artifact"),
];

/** 缺席型表达黑名单——池子里出现任意一个都算失败。 */
const ABSENCE_WORDS = ["没有", "还没", "尚未", "天没", "已经很久", "不再", "缺少"];

describe("insight facts", () => {
  it("returns null when there are fewer than 3 items", () => {
    const few = items.slice(0, 2);
    expect(pickInsightFact(few, new Date("2026-03-01T09:00:00+08:00"))).toBeNull();
  });

  it("prefers the anniversary fact and picks the earliest match", () => {
    const withTwoAnniversaries = [
      ...items,
      makeItem("i7", "另一片叶子", "浙江 · 莫干山", "CHN", "2019-10-12T10:00:00+08:00"),
    ];
    // 2026-10-12 是 i1(2025) 和 i7(2019) 的共同周年，应取最早的 i7
    const fact = pickInsightFact(
      withTwoAnniversaries,
      new Date(2026, 9, 12, 9, 0, 0),
    );
    expect(fact?.kind).toBe("anniversary");
    expect(fact?.key).toBe("anniversary:i7");
    expect(fact?.fact).toContain("2019年的今天");
    expect(fact?.fact).toContain("另一片叶子");
  });

  it("rotates: at least 5 distinct keys across 7 consecutive days", () => {
    const keys = new Set<string>();
    for (let day = 1; day <= 7; day += 1) {
      const fact = pickInsightFact(items, new Date(2026, 2, day, 9, 0, 0));
      expect(fact).not.toBeNull();
      keys.add(fact!.key);
    }
    expect(keys.size).toBeGreaterThanOrEqual(5);
  });

  it("is stable within the same day and item count", () => {
    const morning = pickInsightFact(items, new Date(2026, 2, 4, 8, 0, 0));
    const evening = pickInsightFact(items, new Date(2026, 2, 4, 22, 30, 0));
    expect(morning?.key).toBe(evening?.key);
    expect(morning?.fact).toBe(evening?.fact);
  });

  it("skips keys used in the last few days", () => {
    const today = new Date(2026, 2, 4, 9, 0, 0);
    const first = pickInsightFact(items, today);
    expect(first).not.toBeNull();
    const second = pickInsightFact(items, today, [first!.key]);
    expect(second).not.toBeNull();
    expect(second!.key).not.toBe(first!.key);
  });

  it("never emits absence-shaped facts in any kind", () => {
    // 遍历多个日期，把所有 kind 的文案都跑出来
    const seen = new Map<string, InsightFact>();
    for (let day = 1; day <= 31; day += 1) {
      for (const fact of buildInsightPool(items, new Date(2026, 9, day, 9, 0, 0))) {
        seen.set(fact.key, fact);
      }
    }

    const kinds = new Set([...seen.values()].map((fact) => fact.kind));
    expect(kinds.has("memory")).toBe(true);
    expect(kinds.has("place")).toBe(true);
    expect(kinds.has("milestone")).toBe(true);
    expect(kinds.has("span")).toBe(true);
    expect(kinds.has("category")).toBe(true);
    expect(kinds.has("anniversary")).toBe(true);

    for (const fact of seen.values()) {
      for (const word of ABSENCE_WORDS) {
        expect(fact.fact.includes(word)).toBe(false);
      }
    }
  });

  it("counts places and spans from real data", () => {
    const pool = buildInsightPool(items, new Date(2026, 2, 4, 9, 0, 0));
    const place = pool.find((fact) => fact.kind === "place");
    // 浙江有 2 件（莫干山 + 天目山）
    expect(place?.fact).toContain("浙江");
    expect(place?.fact).toContain("2 件");

    const milestone = pool.find((fact) => fact.kind === "milestone");
    expect(milestone?.fact).toContain("6 件");
    // CHN 出现 3 次，去重后是 CHN / GBR / AUT / JPN 共 4 个
    expect(milestone?.fact).toContain("4 个国家或地区");

    const span = pool.find((fact) => fact.kind === "span");
    // 2021 → 2025 共 5 年
    expect(span?.fact).toContain("5 年");
    expect(span?.fact).toContain("白瓷咖啡杯");
  });

  it("ignores items with unparsable dates or empty names", () => {
    const dirty = [
      ...items,
      makeItem("bad1", "", "浙江 · 某处", "CHN", "2024-01-01T00:00:00+08:00"),
      makeItem("bad2", "坏日期", "浙江 · 某处", "CHN", "not-a-date"),
    ];
    const pool = buildInsightPool(dirty, new Date(2026, 2, 4, 9, 0, 0));
    const milestone = pool.find((fact) => fact.kind === "milestone");
    // 仍然是 6 件，两条脏数据被跳过
    expect(milestone?.fact).toContain("6 件");
    expect(pool.every((fact) => !fact.fact.includes("坏日期"))).toBe(true);
  });
});
