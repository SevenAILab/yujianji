import { describe, expect, it } from "vitest";
import {
  assertReunionPreserved,
  parseAvResult,
  AvParseError,
} from "../src/lib/av-result";
import {
  calculateFrameTimes,
  getEffectiveVideoDuration,
} from "../src/lib/av";
import { createAvDraft } from "../src/lib/av-draft";
import type { AvResult, HistoryEntry, Item } from "../src/lib/types";

const history: HistoryEntry[] = [
  {
    id: "moganshan-pink-leaf-2025-10",
    name: "粉色叶子",
    category: "plant" as const,
    place: "浙江 · 莫干山",
    date: "2025-10-12T16:32:00+08:00",
    userNote: "第一次见到粉色的叶子。",
  },
];

const reunionSegment = {
  unrecognized: false,
  frameIndex: 0,
  heard: "我第一次见这种粉色的叶子",
  name: "粉色叶子",
  nameEn: "Pink leaf",
  category: "plant" as const,
  cognition: "这是一片粉色叶片。",
  fun: "叶片颜色会随季节和生长状态变化。",
  luck: {
    text: "你又遇见了这种特别的颜色。",
    basis: "依据是照片中的叶色和历史记录。",
    confidence: "medium" as const,
  },
  question: "你还记得上一次在哪里见到它吗？",
  verdict: "reunion",
  relatedItemId: "moganshan-pink-leaf-2025-10",
  relatedItemName: "粉色叶子",
  matchBasis: "照片主体与历史中的粉色叶子相同。",
  matchConfidence: "high",
  memorySentence: "其实去年在莫干山，我们已经见过了。",
};

describe("parseAvResult", () => {
  it("accepts an empty recognized=false result without inventing segments", () => {
    expect(
      parseAvResult(
        JSON.stringify({
          recognized: false,
          placeHint: null,
          segments: [],
        }),
        history,
        3,
      ),
    ).toEqual({ recognized: false, placeHint: null, segments: [] });
  });

  it("resolves a valid reunion to trusted history data", () => {
    const parsed = parseAvResult(
      JSON.stringify({
        recognized: true,
        placeHint: "莫干山",
        segments: [reunionSegment],
      }),
      history,
      3,
    );

    if (!parsed.recognized) throw new Error("expected recognized result");
    expect(parsed.segments[0]).toMatchObject({
      associationStatus: "confirmed",
      relatedItemId: "moganshan-pink-leaf-2025-10",
      relatedItemName: "粉色叶子",
    });
  });

  it("marks a low-confidence but valid association for confirmation", () => {
    const parsed = parseAvResult(
      JSON.stringify({
        recognized: true,
        placeHint: null,
        segments: [
          {
            ...reunionSegment,
            matchConfidence: "low",
          },
        ],
      }),
      history,
      1,
    );

    if (!parsed.recognized) throw new Error("expected recognized result");
    expect(parsed.segments[0].associationStatus).toBe("uncertain");
  });

  it("rejects an association name mismatch or missing id", () => {
    expect(() =>
      parseAvResult(
        JSON.stringify({
          recognized: true,
          placeHint: null,
          segments: [
            {
              ...reunionSegment,
              relatedItemName: "蕨叶",
            },
          ],
        }),
        history,
        1,
      ),
    ).toThrowError(AvParseError);

    expect(() =>
      parseAvResult(
        JSON.stringify({
          recognized: true,
          placeHint: null,
          segments: [
            {
              ...reunionSegment,
              relatedItemId: "missing",
            },
          ],
        }),
        history,
        1,
      ),
    ).toThrowError(AvParseError);
  });

  it("rejects frame indexes outside the actual submitted frame count", () => {
    expect(() =>
      parseAvResult(
        JSON.stringify({
          recognized: true,
          placeHint: null,
          segments: [{ ...reunionSegment, frameIndex: 2 }],
        }),
        history,
        2,
      ),
    ).toThrowError(AvParseError);
  });

  it("rejects a retry that silently changes an invalid reunion to first", () => {
    const retryResult: AvResult = {
      recognized: true,
      placeHint: null,
      segments: [
        {
          ...reunionSegment,
          unrecognized: false as const,
          verdict: "first",
          relatedItemId: null,
          relatedItemName: null,
          matchBasis: null,
          matchConfidence: null,
          associationStatus: "none",
        },
      ],
    };

    expect(() =>
      assertReunionPreserved(retryResult, [
        {
          frameIndex: 0,
          category: "plant" as const,
          relatedItemId: "moganshan-pink-leaf-2025-10",
          relatedItemName: "粉色叶子",
        },
      ]),
    ).toThrowError(AvParseError);
  });
});

describe("calculateFrameTimes", () => {
  it("uses one safe midpoint for very short clips", () => {
    expect(calculateFrameTimes(0.4)).toEqual([0.2]);
  });

  it("samples every four seconds with a maximum of six frames", () => {
    expect(calculateFrameTimes(9.5)).toHaveLength(3);
    expect(calculateFrameTimes(60)).toHaveLength(6);
    expect(calculateFrameTimes(9.5)[0]).toBeCloseTo(0.3);
    expect(calculateFrameTimes(9.5).at(-1)).toBeCloseTo(9.2);
  });
});

describe("getEffectiveVideoDuration", () => {
  it("keeps short clips unchanged", () => {
    expect(getEffectiveVideoDuration(18)).toEqual({
      durationSec: 18,
      truncated: false,
    });
  });

  it("limits long clips to the first 60 seconds", () => {
    expect(getEffectiveVideoDuration(92)).toEqual({
      durationSec: 60,
      truncated: true,
    });
  });
});

describe("createAvDraft", () => {
  const result: Extract<AvResult, { recognized: true }> = {
    recognized: true,
    placeHint: "深圳",
    segments: [
      {
        ...reunionSegment,
        unrecognized: false as const,
        verdict: "first",
        relatedItemId: null,
        relatedItemName: null,
        matchBasis: null,
        matchConfidence: null,
        associationStatus: "none",
      },
    ],
  };
  const frame = {
    dataUrl: "data:image/jpeg;base64,AA==",
    atSec: 0.3,
  };

  it("does not inherit fallback coordinates as trusted map data", () => {
    const fallbackItem: Item = {
      id: "fallback",
      name: "旧记录",
      category: "other",
      photo: frame.dataUrl,
      place: "深圳",
      country: "CHN",
      lat: 22.54,
      lng: 114.06,
      locationSource: "default",
      placeSource: "default",
      date: "2026-09-05T00:00:00.000Z",
      userNote: "",
      ai: null,
      isSeed: false,
      createdAt: "2026-09-05T00:00:00.000Z",
    };

    expect(
      createAvDraft(result, [frame], [fallbackItem], Date.now()).coordinate,
    ).toBeNull();
  });

  it("matches a user place fallback to a trusted previous coordinate", () => {
    const trustedItem: Item = {
      id: "trusted",
      name: "莫干山记录",
      category: "landscape",
      photo: frame.dataUrl,
      place: "浙江 · 莫干山",
      country: "CHN",
      lat: 30.62,
      lng: 119.87,
      locationSource: "previous",
      placeSource: "manual",
      date: "2025-10-12T00:00:00.000Z",
      userNote: "",
      ai: null,
      isSeed: false,
      createdAt: "2025-10-12T00:00:00.000Z",
    };

    const draft = createAvDraft(
      { ...result, placeHint: null },
      [frame],
      [trustedItem],
      Date.now(),
      "莫干山",
    );

    expect(draft.initialPlace).toBe("莫干山");
    expect(draft.initialPlaceSource).toBe("manual");
    expect(draft.coordinate).toMatchObject({
      place: "浙江 · 莫干山",
      country: "CHN",
      lat: 30.62,
      lng: 119.87,
      source: "previous",
    });
  });
});
