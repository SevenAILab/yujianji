"use client";

// 分块上传：顺序上传，单块失败重试 3 次；续传以服务端已收到的块为准（刷新页面后不信本地计数）。
import { chunkCount, chunkRange, pendingChunks } from "../upload-plan";
import { MemoApiError, memoApi } from "./api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadBlob(opts: {
  uploadId: string;
  blob: Blob;
  mime: string;
  /** 声纹注册音频，有就在合并前先传给服务端 */
  enroll?: { blob: Blob; durationMs: number };
  onProgress?: (confirmed: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<{ totalChunks: number; sizeBytes: number }> {
  const total = chunkCount(opts.blob.size);
  let received: number[] = [];
  try {
    const status = await memoApi.uploadStatus(opts.uploadId);
    if (status.phase !== "uploading") return { totalChunks: total, sizeBytes: opts.blob.size };
    received = status.received;
  } catch (error) {
    if (!(error instanceof MemoApiError && error.code === "NOT_FOUND")) throw error;
  }

  const send = async (index: number) => {
    const { start, end } = chunkRange(index, opts.blob.size);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await memoApi.uploadChunk(opts.uploadId, index, total, opts.blob.slice(start, end), opts.signal);
        return;
      } catch (error) {
        if (attempt === 3 || opts.signal?.aborted) throw error;
        if (error instanceof MemoApiError && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
        await sleep(800 * attempt);
      }
    }
  };

  let confirmed = received.length;
  opts.onProgress?.(confirmed, total);
  for (const index of pendingChunks(total, received)) {
    await send(index);
    confirmed += 1;
    opts.onProgress?.(confirmed, total);
  }

  // 注册音频传失败不影响主链路，定"我"退回响度就是了
  let enrollMs: number | undefined;
  if (opts.enroll && opts.enroll.blob.size > 0) {
    try {
      await memoApi.uploadEnroll(opts.uploadId, opts.enroll.durationMs, opts.enroll.blob);
      enrollMs = opts.enroll.durationMs;
    } catch {
      enrollMs = undefined;
    }
  }

  try {
    const done = await memoApi.finishUpload(opts.uploadId, total, opts.mime, enrollMs);
    return { totalChunks: total, sizeBytes: done.sizeBytes };
  } catch (error) {
    // 服务端说还缺块（比如某块写盘失败）：补传一次再合并
    if (error instanceof MemoApiError && error.code === "MISSING_CHUNKS" && Array.isArray(error.payload.missing)) {
      for (const index of error.payload.missing as number[]) await send(index);
      const done = await memoApi.finishUpload(opts.uploadId, total, opts.mime, enrollMs);
      return { totalChunks: total, sizeBytes: done.sizeBytes };
    }
    throw error;
  }
}
