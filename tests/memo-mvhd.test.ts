import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findTypeOffsets, parseMvhdHeader, readMvhdFromBlob } from "../src/lib/memo/mvhd";

const MAC_EPOCH = 2_082_844_800;

function mvhdBox(version: 0 | 1, creationIso: string, timescale = 1000, duration = 33_033): Uint8Array {
  const size = version === 0 ? 108 : 120;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set([0x6d, 0x76, 0x68, 0x64], 4);
  view.setUint8(8, version);
  const creation = Math.floor(new Date(creationIso).getTime() / 1000) + MAC_EPOCH;
  if (version === 0) {
    view.setUint32(12, creation);
    view.setUint32(16, creation);
    view.setUint32(20, timescale);
    view.setUint32(24, duration);
  } else {
    view.setBigUint64(12, BigInt(creation));
    view.setBigUint64(20, BigInt(creation));
    view.setUint32(28, timescale);
    view.setBigUint64(32, BigInt(duration));
  }
  return bytes;
}

describe("mvhd 录制时间", () => {
  it("version 0：4 字节时间，起点 1904-01-01 UTC", () => {
    const info = parseMvhdHeader(mvhdBox(0, "2026-09-15T06:20:00Z"));
    expect(info?.creationTime).toBe("2026-09-15T06:20:00.000Z");
    expect(info?.durationSec).toBeCloseTo(33.033, 3);
  });

  it("version 1：8 字节时间", () => {
    const info = parseMvhdHeader(mvhdBox(1, "2026-09-21T02:05:00Z", 48_000, 48_000 * 77));
    expect(info?.creationTime).toBe("2026-09-21T02:05:00.000Z");
    expect(info?.durationSec).toBe(77);
  });

  it("音频数据里碰巧出现 mvhd 四个字节，但 size / version 不对 → 不当真", () => {
    const fake = mvhdBox(0, "2026-09-15T06:20:00Z");
    new DataView(fake.buffer).setUint32(0, 999);
    expect(parseMvhdHeader(fake)).toBeNull();
  });

  it("creation_time 为 0（设备没写）→ 时间为 null，让用户确认", () => {
    const box = mvhdBox(0, "2026-09-15T06:20:00Z");
    new DataView(box.buffer).setUint32(12, 0);
    expect(parseMvhdHeader(box)?.creationTime).toBeNull();
  });

  it("moov 在文件末尾、mvhd 正好跨 4MB 分段边界时也能找到", async () => {
    const seg = 4 * 1024 * 1024;
    const file = new Uint8Array(9 * 1024 * 1024);
    file.set(mvhdBox(0, "2026-09-22T06:20:00Z"), seg - 6);
    const info = await readMvhdFromBlob(new Blob([file]));
    expect(info?.creationTime).toBe("2026-09-22T06:20:00.000Z");
  });

  it("findTypeOffsets 找出所有 mvhd 位置", () => {
    const bytes = new Uint8Array(40);
    bytes.set([0x6d, 0x76, 0x68, 0x64], 10);
    expect(findTypeOffsets(bytes)).toEqual([10]);
  });

  const fixture = path.resolve(__dirname, "../spikes/memo/fixtures/demo-1min.m4a");
  it.skipIf(!existsSync(fixture))("真实 m4a（ffmpeg 写入 creation_time 的双声道 AAC）", async () => {
    const info = await readMvhdFromBlob(new Blob([readFileSync(fixture)]));
    expect(info?.creationTime).toBe("2026-09-15T06:20:00.000Z");
    expect(info?.durationSec).toBeGreaterThan(30);
  });
});
