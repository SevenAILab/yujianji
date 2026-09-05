import { describe, expect, it } from "vitest";
import { normalizeCapturedDate } from "../src/lib/image-date";

describe("normalizeCapturedDate", () => {
  it("accepts a plausible EXIF date", () => {
    expect(
      normalizeCapturedDate(
        new Date("2025-08-03T12:30:00Z"),
        new Date("2026-09-05T08:00:00Z"),
        new Date("2026-09-05T09:00:00Z"),
      ),
    ).toEqual({
      date: "2025-08-03T12:30:00.000Z",
      source: "exif",
    });
  });

  it("falls back from future EXIF to file modified time", () => {
    expect(
      normalizeCapturedDate(
        new Date("2030-01-01T00:00:00Z"),
        new Date("2026-09-04T08:00:00Z"),
        new Date("2026-09-05T09:00:00Z"),
      ),
    ).toEqual({
      date: "2026-09-04T08:00:00.000Z",
      source: "fileModified",
    });
  });
});
