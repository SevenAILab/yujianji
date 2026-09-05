import { describe, expect, it } from "vitest";
import {
  buildMapPins,
  deriveLocationId,
  mapPinsRequestSchema,
} from "../src/lib/map-pins";

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
});
