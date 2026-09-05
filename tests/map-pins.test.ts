import { describe, expect, it } from "vitest";
import {
  buildMapPins,
  deriveLocationId,
  mapPinsRequestSchema,
} from "../src/lib/map-pins";
import { hydrateMapPins } from "../src/lib/local-map-pins";
import type { Item } from "../src/lib/types";

const shanghai = {
  id: "memory-1",
  name: "梧桐叶",
  place: "上海 · 徐汇",
  country: "CHN",
  lat: 31.201,
  lng: 121.438,
  date: "2026-04-02T10:00:00+08:00",
  userNote: "雨后的街道很亮",
};

describe("map pins", () => {
  it("links memories in the same first-level region", () => {
    const input = mapPinsRequestSchema.parse({
      items: [
        shanghai,
        {
          ...shanghai,
          id: "memory-2",
          name: "街角咖啡",
          date: "2026-05-03T09:00:00+08:00",
        },
      ],
    });

    const [pin] = buildMapPins(input);
    expect(pin.memoryCount).toBe(2);
    expect(pin.itemIds).toEqual(["memory-2", "memory-1"]);
    expect(pin.region?.id).toBe("CN-SH");
    expect(pin.coverItemId).toBe("memory-2");
    expect(pin.locations).toHaveLength(1);
    expect(pin.locations[0].coverItemId).toBe("memory-2");
    expect(pin.locations[0].itemIds).toEqual(["memory-2", "memory-1"]);
  });

  it("resolves Fuzhou to Fujian and Darmstadt to Hesse", () => {
    const input = mapPinsRequestSchema.parse({
      items: [
        { ...shanghai, id: "fuzhou", place: "福州", lat: 26.0745, lng: 119.2965 },
        { ...shanghai, id: "darmstadt", place: "达姆斯塔特", country: "DEU", lat: 49.8728, lng: 8.6512 },
      ],
    });
    const regionIds = buildMapPins(input).map((pin) => pin.region?.id);
    expect(regionIds).toContain("CN-FJ");
    expect(regionIds).toContain("DE-HE");
  });

  it("uses an explicit location id when one exists", () => {
    expect(deriveLocationId({ ...shanghai, locationId: "place:shanghai-xuhui" })).toBe(
      "place:shanghai-xuhui",
    );
  });

  it("supports map bounds crossing the date line", () => {
    const input = mapPinsRequestSchema.parse({
      bounds: { west: 170, south: -90, east: -170, north: 90 },
      items: [
        { ...shanghai, id: "east", place: "斐济", lat: -17.7, lng: 178.1 },
        { ...shanghai, id: "west", place: "萨摩亚", lat: -13.8, lng: -171.8 },
        shanghai,
      ],
    });

    expect(buildMapPins(input)).toHaveLength(2);
  });

  it("accepts records without coordinates and excludes them from pins", () => {
    const input = mapPinsRequestSchema.parse({
      items: [
        { ...shanghai, lat: null, lng: null },
        { ...shanghai, id: "with-coordinates" },
      ],
    });

    const pins = buildMapPins(input);
    expect(pins).toHaveLength(1);
    expect(pins[0].itemIds).toEqual(["with-coordinates"]);
  });

  it("marks a Shenzhen panorama so the globe can render its distinct pin", () => {
    const input = mapPinsRequestSchema.parse({
      items: [{
        ...shanghai,
        id: "shenzhen-panorama",
        place: "中国 · 深圳",
        lat: 22.5431,
        lng: 114.0579,
        mediaKind: "panorama",
      }],
    });

    const [pin] = buildMapPins(input);
    expect(pin.region?.id).toBe("CN-GD");
    expect(pin.locations[0]).toMatchObject({
      hasPanorama: true,
      panoramaItemId: "shenzhen-panorama",
    });
  });

  it("hydrates three Shenzhen panorama pin previews with their own images and 360 flags", () => {
    const items = [
      { ...shanghai, id: "shenzhen-studio", name: "创意空间", photo: "/studio.jpg", mediaKind: "panorama" as const, place: "中国 · 深圳", lat: 22.5431, lng: 114.0579, date: "2026-09-06T21:00:00+08:00" },
      { ...shanghai, id: "shenzhen-night", name: "夜巷", photo: "/night.jpg", mediaKind: "panorama" as const, place: "中国 · 深圳", lat: 22.5431, lng: 114.0579, date: "2026-09-06T20:30:00+08:00" },
      { ...shanghai, id: "shenzhen-office", name: "工作室", photo: "/office.jpg", mediaKind: "panorama" as const, place: "中国 · 深圳", lat: 22.5431, lng: 114.0579, date: "2026-09-06T14:55:00+08:00" },
    ] satisfies Item[];
    const apiPins = buildMapPins(mapPinsRequestSchema.parse({ items }));
    const [pin] = hydrateMapPins(apiPins, items);

    expect(pin.locations).toHaveLength(1);
    expect(pin.locations[0].preview.map(({ id, photo, mediaKind }) => ({ id, photo, mediaKind }))).toEqual([
      { id: "shenzhen-studio", photo: "/studio.jpg", mediaKind: "panorama" },
      { id: "shenzhen-night", photo: "/night.jpg", mediaKind: "panorama" },
      { id: "shenzhen-office", photo: "/office.jpg", mediaKind: "panorama" },
    ]);
  });
});

describe("示例数据钉子", () => {
  const base = {
    id: "seed-1",
    name: "粉色叶子",
    place: "浙江 · 莫干山",
    country: "CHN",
    lat: 30.61,
    lng: 119.9,
    date: "2025-10-12T16:32:00+08:00",
    userNote: "",
    isSeed: true,
  };

  it("整组都是示例时 allSeed 为 true", () => {
    const input = mapPinsRequestSchema.parse({
      items: [base, { ...base, id: "seed-2", date: "2024-05-01T10:00:00+08:00" }],
    });
    const [pin] = buildMapPins(input);
    expect(pin.allSeed).toBe(true);
    expect(pin.locations.every((location) => location.allSeed)).toBe(true);
  });

  it("只要混进一条用户自己的记录就不算示例", () => {
    const input = mapPinsRequestSchema.parse({
      items: [base, { ...base, id: "mine-1", isSeed: false, date: "2026-09-05T10:00:00+08:00" }],
    });
    const [pin] = buildMapPins(input);
    expect(pin.allSeed).toBe(false);
  });

  it("缺省 isSeed 时按用户记录处理，不会被误标成示例", () => {
    const { isSeed: _drop, ...withoutFlag } = base;
    const input = mapPinsRequestSchema.parse({ items: [withoutFlag] });
    const [pin] = buildMapPins(input);
    expect(pin.allSeed).toBe(false);
  });
});
