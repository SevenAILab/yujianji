import { describe, expect, it } from "vitest";
import { generateJourney, journeyGenerationRequestSchema } from "../src/lib/journey-generator";

const item = {
  id: "a",
  name: "玄武岩",
  category: "mineral" as const,
  place: "冰岛 · 维克",
  country: "ISL",
  lat: 63.42,
  lng: -19.0,
  date: "2026-07-02T10:00:00Z",
  userNote: "第一次摸到黑色火山石。",
  memorySentence: "第一次遇见火山留下的黑色纹理。",
  verdict: "first" as const,
  cognition: "黑色玄武岩",
};

describe("journey generator", () => {
  it("filters the requested range and groups nearby records into one stop", () => {
    const input = journeyGenerationRequestSchema.parse({
      startDate: "2026-07-01",
      endDate: "2026-07-05",
      items: [item, { ...item, id: "b", lat: 63.421, lng: -19.002, date: "2026-07-03T10:00:00Z" }, { ...item, id: "outside", date: "2026-08-03T10:00:00Z" }],
    });
    const journey = generateJourney(input);
    expect(journey?.recordCount).toBe(2);
    expect(journey?.stops).toHaveLength(1);
    expect(journey?.stops[0].recordCount).toBe(2);
    expect(journey?.regions).toHaveLength(1);
    expect(journey?.regions[0].country).toBe("ISL");
    expect(journey?.regions[0].geometry.type).toMatch(/Polygon/);
    expect(journey?.stops[0].regionId).toBe(journey?.regions[0].id);
  });

  it("uses subject cutout for objects and polaroid for landscapes", () => {
    const input = journeyGenerationRequestSchema.parse({ startDate: "2026-07-01", endDate: "2026-07-05", items: [item, { ...item, id: "view", category: "landscape", place: "冰岛 · 冰河湖", lat: 64.04, lng: -16.18 }] });
    const journey = generateJourney(input);
    expect(journey?.stops.map((stop) => stop.hasDetectedSubject)).toEqual([true, false]);
  });

  it("combines every involved first-level administrative region", () => {
    const input = journeyGenerationRequestSchema.parse({
      startDate: "2026-07-01",
      endDate: "2026-07-05",
      items: [
        { ...item, id: "shanghai", country: "CHN", place: "上海", lat: 31.2304, lng: 121.4737 },
        { ...item, id: "hangzhou", country: "CHN", place: "杭州", lat: 30.2741, lng: 120.1551 },
      ],
    });
    const journey = generateJourney(input);
    expect(journey?.regions).toHaveLength(2);
    expect(new Set(journey?.regions.map((region) => region.name))).toEqual(new Set(["上海市", "浙江省"]));
  });
});
