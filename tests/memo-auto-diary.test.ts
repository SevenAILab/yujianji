import { describe, expect, it } from "vitest";
import { staleDays } from "../src/lib/memo/client/auto-diary";

describe("过零点自动补生成", () => {
  const today = "2026-09-24";

  it("今天以前、有素材、还没写的日子要补；今天不补", () => {
    const days = staleDays({
      today,
      materials: [
        { dayKey: "2026-09-24", latestAt: "2026-09-24T02:00:00.000Z" },
        { dayKey: "2026-09-23", latestAt: "2026-09-23T10:00:00.000Z" },
        { dayKey: "2026-09-22", latestAt: null },
      ],
      diaries: new Map(),
    });
    expect(days).toEqual(["2026-09-23"]);
  });

  it("写完之后又有新素材的要重写；写完之后没动过的不重写（不重复花钱）", () => {
    const days = staleDays({
      today,
      materials: [
        { dayKey: "2026-09-23", latestAt: "2026-09-23T14:00:00.000Z" },
        { dayKey: "2026-09-21", latestAt: "2026-09-21T10:00:00.000Z" },
      ],
      diaries: new Map([
        ["2026-09-23", { generatedAt: "2026-09-23T12:00:00.000Z" }],
        ["2026-09-21", { generatedAt: "2026-09-21T23:00:00.000Z" }],
      ]),
    });
    expect(days).toEqual(["2026-09-23"]);
  });
});
