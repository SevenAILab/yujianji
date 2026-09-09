import { describe, expect, it } from "vitest";
import { formatBytes, shouldSuggestBackup } from "../src/lib/storage-health";

describe("备份提醒时机", () => {
  it("记录太少时不打扰", () => {
    expect(shouldSuggestBackup(3, null)).toBe(false);
    expect(shouldSuggestBackup(9, null)).toBe(false);
  });

  it("攒够记录但从没导出过就该提醒", () => {
    expect(shouldSuggestBackup(10, null)).toBe(true);
  });

  it("刚导出过就不提醒", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(shouldSuggestBackup(50, yesterday)).toBe(false);
  });

  it("超过 30 天没导出就再提醒一次", () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldSuggestBackup(50, longAgo)).toBe(true);
  });

  it("存的时间戳坏掉时按没导出处理，不静默跳过", () => {
    expect(shouldSuggestBackup(50, "not-a-date")).toBe(true);
  });
});

describe("字节格式化", () => {
  it("读不到用量时说未知，不编数字", () => {
    expect(formatBytes(null)).toBe("未知");
  });

  it("按量级换单位", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
