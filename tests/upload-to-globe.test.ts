import { describe, expect, it } from "vitest";
import { buildMapPins, mapPinsRequestSchema } from "../src/lib/map-pins";
import { itemSchema } from "../src/lib/schema";

const uploadedPhoto =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";

describe("uploaded photo to globe contract", () => {
  it("turns a saved Fuzhou photo into a Fujian region pin and reconnects its local photo", () => {
    const savedItem = itemSchema.parse({
      id: "upload-fuzhou-001",
      name: "测试照片",
      category: "other",
      photo: uploadedPhoto,
      place: "福州",
      country: "CHN",
      lat: 26.0745,
      lng: 119.2965,
      locationSource: "gps",
      date: "2026-09-05T16:00:00+08:00",
      userNote: "上传到地球的联通测试",
      ai: null,
      isSeed: false,
      createdAt: "2026-09-05T16:00:00+08:00",
    });

    // This mirrors the homepage boundary: private/heavy photo data stays in
    // IndexedDB, while only location metadata is sent to /api/map-pins.
    const { photo: _photo, ai: _ai, ...mapItem } = savedItem;
    const request = mapPinsRequestSchema.parse({ items: [mapItem] });
    const pins = buildMapPins(request);

    expect(pins).toHaveLength(1);
    expect(pins[0].region?.id).toBe("CN-FJ");
    expect(pins[0].locations[0]).toMatchObject({
      name: "福州",
      coverItemId: savedItem.id,
      itemIds: [savedItem.id],
    });

    // This mirrors the client-side hydration performed after the API returns.
    const coverPhoto =
      [savedItem].find((item) => item.id === pins[0].locations[0].coverItemId)
        ?.photo ?? "";
    expect(coverPhoto).toBe(uploadedPhoto);
  });

  it("rejects records without usable coordinates before they reach the globe", () => {
    const invalid = itemSchema.safeParse({
      id: "upload-invalid-location",
      name: "无坐标照片",
      category: "other",
      photo: uploadedPhoto,
      place: "福州",
      country: "CHN",
      lat: Number.NaN,
      lng: Number.NaN,
      locationSource: "manual",
      date: "2026-09-05T16:00:00+08:00",
      userNote: "",
      ai: null,
      isSeed: false,
      createdAt: "2026-09-05T16:00:00+08:00",
    });

    expect(invalid.success).toBe(false);
  });

  it("resolves the region from coordinates, not from manually typed place text", () => {
    const request = mapPinsRequestSchema.parse({
      items: [
        {
          id: "manual-place-with-default-position",
          name: "位置风险测试",
          place: "福州",
          country: "CHN",
          lat: 22.54,
          lng: 114.06,
          date: "2026-09-05T16:00:00+08:00",
          userNote: "地点文字和坐标不一致",
        },
      ],
    });

    const [pin] = buildMapPins(request);
    expect(pin.locations[0].name).toBe("福州");
    expect(pin.region?.id).not.toBe("CN-FJ");
  });
});
