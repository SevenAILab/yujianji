import { describe, expect, it } from "vitest";
import { mergeBackupItems } from "../src/lib/backup";
import { itemSchema } from "../src/lib/schema";
import type { Item } from "../src/lib/types";

function makeItem(id: string, createdAt: string, name = "测试藏品"): Item {
  return itemSchema.parse({
    id,
    name,
    category: "plant",
    photo: "data:image/jpeg;base64,AAAA",
    place: "杭州",
    country: "CHN",
    lat: 30.2,
    lng: 120.1,
    locationSource: "gps",
    date: createdAt,
    userNote: "第一次见",
    ai: null,
    isSeed: false,
    createdAt,
  }) as Item;
}

describe("备份合并", () => {
  it("本机没有的记录会被新增", () => {
    const incoming = [makeItem("a", "2026-01-01T00:00:00Z")];
    const result = mergeBackupItems(incoming, [undefined]);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.toWrite).toHaveLength(1);
  });

  it("同一份备份导入两次不会产生重复写入", () => {
    const item = makeItem("a", "2026-01-01T00:00:00Z");
    const result = mergeBackupItems([item], [item]);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.toWrite).toHaveLength(0);
  });

  it("备份里更新的那条会覆盖本机的旧版本", () => {
    const older = makeItem("a", "2026-01-01T00:00:00Z", "旧名字");
    const newer = makeItem("a", "2026-02-01T00:00:00Z", "新名字");
    const result = mergeBackupItems([newer], [older]);
    expect(result.updated).toBe(1);
    expect(result.toWrite[0].name).toBe("新名字");
  });

  it("本机更新时不会被备份里的旧版本冲掉", () => {
    const older = makeItem("a", "2026-01-01T00:00:00Z", "备份里的旧的");
    const newer = makeItem("a", "2026-02-01T00:00:00Z", "本机新的");
    const result = mergeBackupItems([older], [newer]);
    expect(result.skipped).toBe(1);
    expect(result.toWrite).toHaveLength(0);
  });

  it("混合场景的计数分别正确", () => {
    const incoming = [
      makeItem("a", "2026-01-01T00:00:00Z"),
      makeItem("b", "2026-03-01T00:00:00Z"),
      makeItem("c", "2026-01-01T00:00:00Z"),
    ];
    const existing = [
      undefined,
      makeItem("b", "2026-02-01T00:00:00Z"),
      makeItem("c", "2026-01-01T00:00:00Z"),
    ];
    const result = mergeBackupItems(incoming, existing);
    expect(result).toMatchObject({ added: 1, updated: 1, skipped: 1 });
  });
});
