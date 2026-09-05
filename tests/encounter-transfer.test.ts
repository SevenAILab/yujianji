import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedStorage = vi.hoisted(() => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    pendingEncounters: {
      put: vi.fn(async (row: { key: string }) => {
        rows.set(row.key, row);
      }),
      get: vi.fn(async (key: string) => rows.get(key)),
      delete: vi.fn(async (key: string) => {
        rows.delete(key);
      }),
    },
  };
});

vi.mock("../src/lib/db", () => ({
  db: { pendingEncounters: mockedStorage.pendingEncounters },
}));

describe("encounter file transfer", () => {
  beforeEach(() => {
    mockedStorage.rows.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("hands a selected photo to the encounter page", async () => {
    const transfer = await import("../src/lib/encounter-transfer");
    const file = new File(["photo"], "travel.jpg", { type: "image/jpeg" });

    await transfer.setPendingEncounterFile(file, "album");
    const pending = await transfer.takePendingEncounterFile();

    expect(pending?.file.name).toBe("travel.jpg");
    expect(pending?.file.type).toBe("image/jpeg");
    expect(pending?.source).toBe("album");
  });

  it("restores the selected file after the page module reloads", async () => {
    const firstPage = await import("../src/lib/encounter-transfer");
    const file = new File(["camera"], "capture.jpg", {
      type: "image/jpeg",
      lastModified: 1234,
    });
    await firstPage.setPendingEncounterFile(file, "camera");

    vi.resetModules();
    const restoredPage = await import("../src/lib/encounter-transfer");
    const pending = await restoredPage.takePendingEncounterFile();

    expect(pending?.file.name).toBe("capture.jpg");
    expect(pending?.file.lastModified).toBe(1234);
    expect(pending?.source).toBe("camera");
    expect(mockedStorage.rows.size).toBe(0);
  });
});
