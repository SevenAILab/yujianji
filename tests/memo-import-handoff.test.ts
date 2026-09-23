import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearPendingMemoImport, isAudioFile, peekPendingMemoImport, setPendingMemoImport } from "../src/lib/memo/client/import-handoff";
import { takePendingEncounterFile } from "../src/lib/encounter-transfer";

describe("首页「导入」分流", () => {
  it("按类型和扩展名认录音；.m4a 被报成 video/mp4 也算录音", () => {
    expect(isAudioFile({ name: "语音备忘录.m4a", type: "audio/x-m4a" })).toBe(true);
    expect(isAudioFile({ name: "新录音.m4a", type: "video/mp4" })).toBe(true);
    expect(isAudioFile({ name: "rec", type: "audio/mpeg" })).toBe(true);
    expect(isAudioFile({ name: "voice.wav", type: "" })).toBe(true);
    expect(isAudioFile({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(false);
    expect(isAudioFile({ name: "clip.mov", type: "video/quicktime" })).toBe(false);
  });

  it("暂存的录音存在 IndexedDB 里：读了不删（失败还能重试），清理后就没了", async () => {
    await setPendingMemoImport(new File(["abc"], "a.m4a", { type: "audio/mp4", lastModified: 1700000000000 }));
    const first = await peekPendingMemoImport();
    const again = await peekPendingMemoImport();
    expect(first?.name).toBe("a.m4a");
    expect(first?.lastModified).toBe(1700000000000);
    expect(again?.name).toBe("a.m4a");
    await clearPendingMemoImport();
    expect(await peekPendingMemoImport()).toBeNull();
  });

  it("和照片交接互不干扰：取照片不会取走暂存的录音", async () => {
    await setPendingMemoImport(new File(["abc"], "a.m4a", { type: "audio/mp4" }));
    expect(await takePendingEncounterFile()).toBeNull();
    expect((await peekPendingMemoImport())?.name).toBe("a.m4a");
    await clearPendingMemoImport();
  });
});
