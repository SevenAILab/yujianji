import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const submitMock = vi.fn(async () => `task-${submitMock.mock.calls.length}-abcdefgh`);
vi.mock("../src/lib/memo/server/bailian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/memo/server/bailian")>();
  return {
    ...actual,
    submitTranscription: (...args: unknown[]) => submitMock(...(args as [])),
    queryTask: vi.fn(async () => ({ status: "SUCCEEDED", transcriptionUrl: "https://example.invalid/result.json" })),
    fetchTranscription: vi.fn(async () => ({
      sentences: [
        { beginMs: 0, endMs: 1000, text: "我觉得这里的人好松弛", speakerId: "1" },
        { beginMs: 1000, endMs: 2000, text: "是啊", speakerId: "0" },
      ],
      durationMs: 2000,
    })),
  };
});

const root = mkdtempSync(path.join(os.tmpdir(), "memo-jobs-"));
process.env.MEMO_TMP_DIR = root;

const jobs = await import("../src/lib/memo/server/jobs");
const store = await import("../src/lib/memo/server/tmp-store");

const device = "dev_abcdefghijklmnop1234";

beforeEach(() => {
  submitMock.mockClear();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("分块上传：幂等与续传", () => {
  it("重复块直接确认；缺块时 finish 返回缺失序号；按序合并", async () => {
    const uploadId = "up_chunktest01";
    const a = new TextEncoder().encode("AAA");
    const b = new TextEncoder().encode("BBB");
    expect(await jobs.saveChunk({ uploadId, deviceId: device, index: 1, total: 2, bytes: b })).toEqual({ received: 1, duplicate: false });
    expect(await jobs.saveChunk({ uploadId, deviceId: device, index: 1, total: 2, bytes: b })).toEqual({ received: 1, duplicate: true });

    const missing = await jobs.finishUpload({ uploadId, deviceId: device, totalChunks: 2, mime: "audio/mp4" }).catch((e) => e);
    expect(missing).toMatchObject({ code: "MISSING_CHUNKS", extra: { missing: [0] } });

    expect((await jobs.uploadStatus(uploadId, device)).received).toEqual([1]);
    await jobs.saveChunk({ uploadId, deviceId: device, index: 0, total: 2, bytes: a });
    expect(await jobs.finishUpload({ uploadId, deviceId: device, totalChunks: 2, mime: "audio/mp4" })).toEqual({ sizeBytes: 6 });
    expect(readFileSync(path.join(root, uploadId, "source.m4a"), "utf8")).toBe("AAABBB");
    // 重复 finish 返回已有结果
    expect(await jobs.finishUpload({ uploadId, deviceId: device, totalChunks: 2, mime: "audio/mp4" })).toEqual({ sizeBytes: 6 });
  });

  it("别的设备拿同一个 uploadId 访问 → 当作不存在", async () => {
    await expect(jobs.uploadStatus("up_chunktest01", "dev_zzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function preparedState(uploadId: string, phase: "prepared" | "submitting" = "prepared") {
  const now = new Date().toISOString();
  await store.writeState({
    uploadId,
    deviceId: device,
    phase,
    totalChunks: 1,
    durationSec: 2,
    parts: [{ partIndex: 0, ossUrl: "oss://x/y.m4a", offsetMs: 0, durationMs: 2000 }],
    createdAt: now,
    updatedAt: now,
  });
}

describe("识别：任务号持久化，重复请求不重复提交", () => {
  it("第一次提交，第二次直接返回已有任务号", async () => {
    await preparedState("up_asrtest0001");
    const first = await jobs.startTranscribe("up_asrtest0001", device);
    const second = await jobs.startTranscribe("up_asrtest0001", device);
    expect(first.reused).toBe(false);
    expect(second).toEqual({ taskIds: first.taskIds, reused: true });
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect((await store.readState("up_asrtest0001"))?.taskIds).toEqual(first.taskIds);
  });

  it("上次停在 submitting（发出去没拿到响应 / 进程崩溃）→ ASR_SUBMIT_UNKNOWN；用户确认后 force 才重提", async () => {
    await preparedState("up_asrtest0002", "submitting");
    await expect(jobs.startTranscribe("up_asrtest0002", device)).rejects.toMatchObject({ code: "ASR_SUBMIT_UNKNOWN" });
    expect(submitMock).not.toHaveBeenCalled();
    const forced = await jobs.startTranscribe("up_asrtest0002", device, true);
    expect(forced.taskIds).toHaveLength(1);
  });

  it("识别成功：按说话人算响度、删掉整个临时目录；之后凭任务号还能取结果（响度降级）", async () => {
    const uploadId = "up_asrtest0003";
    await preparedState(uploadId);
    const { taskIds } = await jobs.startTranscribe(uploadId, device);
    // 8kHz 2 秒：第 1 秒响（我），第 2 秒轻（朋友）
    const pcm = new Int16Array(16_000).map((_, i) => (i < 8000 ? 16_000 : 2_000) * (i % 2 ? 1 : -1));
    writeFileSync(path.join(root, uploadId, "loud8k.pcm"), Buffer.from(pcm.buffer));

    const result = await jobs.transcribeStatus({ uploadId, deviceId: device });
    expect(result.status).toBe("succeeded");
    expect(result.speakersDegraded).toBe(false);
    const me = result.speakers!.find((s) => s.key === "0:1")!;
    const friend = result.speakers!.find((s) => s.key === "0:0")!;
    expect(me.meanDb! - friend.meanDb!).toBeGreaterThan(10);
    expect(existsSync(path.join(root, uploadId))).toBe(false);

    const again = await new Promise<Awaited<ReturnType<typeof jobs.transcribeStatus>>>((resolve) => setTimeout(async () => resolve(await jobs.transcribeStatus({ uploadId: "up_asrtest0004", deviceId: device, taskIds, offsets: [0] })), 5));
    expect(again.status).toBe("succeeded");
    expect(again.speakersDegraded).toBe(true);
  });
});

describe("临时目录清理", () => {
  it("超过 2 小时没更新的上传目录被删", async () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    mkdirSync(path.join(root, "up_stale000001"), { recursive: true });
    writeFileSync(path.join(root, "up_stale000001", "state.json"), JSON.stringify({ uploadId: "up_stale000001", deviceId: device, phase: "failed", totalChunks: 1, createdAt: old, updatedAt: old }));
    await preparedState("up_fresh000001");
    const removed = await store.sweepStale(Date.now(), true);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(root, "up_stale000001"))).toBe(false);
    expect(existsSync(path.join(root, "up_fresh000001"))).toBe(true);
  });
});
