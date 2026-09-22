// 上传 → 转码 → 临时存储 → 识别 的服务端任务。幂等契约（spec v3 §4.3）：
// - uploadId 是整条链路的操作键，由前端生成并先存进手机
// - 分块按序号落盘，重复块直接确认；finish / prepare 重复调用返回已有结果
// - ASR 任务号每提交一段立刻写进 state.json，重复 /transcribe 返回已有任务号，不重复提交、不重复计费
// - "提交请求发出但没拿到响应"时状态停在 submitting：再提交必须带 force，由用户确认可能重复计费
// - 进程重启：preparing 中断会自动安全重跑（不产生识别费用）；已提交的任务号在 state.json 和手机里各有一份
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { asrCostYuan } from "../../agent/pricing";
import { speakerLoudness } from "../loudness";
import { pendingChunks } from "../upload-plan";
import { asrModel, BailianError, fetchTranscription, queryTask, submitTranscription, uploadToTempStorage } from "./bailian";
import { cutPart, ffmpegAvailable, FfmpegError, planParts, prependAudio, probe, transcode } from "./ffmpeg";
import {
  atomicWrite,
  chunkPath,
  chunksDir,
  enroll16kPath,
  enrollSourcePath,
  patchState,
  readState,
  receivedChunks,
  removeFile,
  removeUpload,
  uploadDir,
  writeState,
  type UploadPart,
  type UploadState,
} from "./tmp-store";

export class JobError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra?: Record<string, unknown>;
  constructor(code: string, status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
};

function sourcePath(uploadId: string, mime?: string): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return path.join(uploadDir(uploadId), `source${EXT_BY_MIME[base] ?? ".bin"}`);
}
const mono16kPath = (uploadId: string) => path.join(uploadDir(uploadId), "mono16k.m4a");
const pcm8kPath = (uploadId: string) => path.join(uploadDir(uploadId), "loud8k.pcm");

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function loadOwned(uploadId: string, deviceId: string): Promise<UploadState> {
  const state = await readState(uploadId);
  // 不区分"不存在"和"不是你的"，避免猜 uploadId
  if (!state || state.deviceId !== deviceId) throw new JobError("NOT_FOUND", 404, "上传任务不存在或已过期，请重新上传");
  return state;
}

// ── 分块 ──────────────────────────────────────────────────────────────

export async function saveChunk(input: { uploadId: string; deviceId: string; index: number; total: number; bytes: Uint8Array }): Promise<{ received: number; duplicate: boolean }> {
  let state = await readState(input.uploadId);
  if (!state) {
    const now = new Date().toISOString();
    state = await writeState({ uploadId: input.uploadId, deviceId: input.deviceId, phase: "uploading", totalChunks: input.total, createdAt: now, updatedAt: now });
  } else {
    if (state.deviceId !== input.deviceId) throw new JobError("BAD_UPLOAD_ID", 404, "上传任务不存在");
    if (state.totalChunks !== input.total) throw new JobError("BAD_UPLOAD_ID", 400, "分块总数和第一次上传时不一致");
    if (state.phase !== "uploading") return { received: input.index, duplicate: true };
  }
  const file = chunkPath(input.uploadId, input.index);
  const existing = await stat(file).catch(() => null);
  if (existing && existing.size === input.bytes.byteLength) return { received: input.index, duplicate: true };
  await atomicWrite(file, input.bytes);
  await patchState(input.uploadId, {}); // 刷新 updatedAt，避免长上传被 2 小时清理误删
  return { received: input.index, duplicate: false };
}

export async function uploadStatus(uploadId: string, deviceId: string): Promise<{ phase: UploadState["phase"]; totalChunks: number; received: number[] }> {
  const state = await loadOwned(uploadId, deviceId);
  const received = state.phase === "uploading" ? await receivedChunks(uploadId) : Array.from({ length: state.totalChunks }, (_, i) => i);
  return { phase: state.phase, totalChunks: state.totalChunks, received };
}

export async function finishUpload(input: { uploadId: string; deviceId: string; totalChunks: number; mime: string; enrollMs?: number }): Promise<{ sizeBytes: number }> {
  const state = await loadOwned(input.uploadId, input.deviceId);
  if (state.phase !== "uploading") return { sizeBytes: state.sizeBytes ?? 0 };
  const missing = pendingChunks(input.totalChunks, await receivedChunks(input.uploadId));
  if (missing.length) throw new JobError("MISSING_CHUNKS", 409, "还有分块没传完", { missing });

  const out = sourcePath(input.uploadId, input.mime);
  const partial = `${out}.assembling`;
  const ws = createWriteStream(partial);
  for (let i = 0; i < input.totalChunks; i += 1) {
    await pipeline(createReadStream(chunkPath(input.uploadId, i)), ws, { end: false });
  }
  await new Promise<void>((resolve, reject) => ws.end((error?: Error | null) => (error ? reject(error) : resolve())));
  await rm(out, { force: true });
  await rename(partial, out);
  const sizeBytes = (await stat(out)).size;
  await rm(chunksDir(input.uploadId), { recursive: true, force: true });
  await patchState(input.uploadId, { phase: "assembled", mime: input.mime, sizeBytes, ...(input.enrollMs ? { enrollMs: input.enrollMs } : {}) });
  return { sizeBytes };
}

// ── 转码 + 临时存储 ────────────────────────────────────────────────────

const preparing = new Map<string, Promise<void>>();

export async function startPrepare(uploadId: string, deviceId: string): Promise<UploadState> {
  const state = await loadOwned(uploadId, deviceId);
  if (state.phase === "prepared" || state.phase === "submitting" || state.phase === "submitted") return state;
  if (state.phase === "failed" && state.failedAt !== "prepare") return state;
  if (state.phase === "uploading") throw new JobError("NOT_ASSEMBLED", 409, "音频还没上传完");
  if (preparing.has(uploadId)) return state;
  if (!(await ffmpegAvailable())) throw new JobError("FFMPEG_UNAVAILABLE", 503, "服务器上没有可用的 ffmpeg");

  const next = await patchState(uploadId, { phase: "preparing", error: undefined, failedAt: undefined });
  const job = runPrepare(uploadId).finally(() => preparing.delete(uploadId));
  preparing.set(uploadId, job);
  return next;
}

async function runPrepare(uploadId: string): Promise<void> {
  const state = (await readState(uploadId))!;
  const source = sourcePath(uploadId, state.mime);
  const out16k = mono16kPath(uploadId);
  const pcm = pcm8kPath(uploadId);
  const timings: Record<string, number> = { ...(state.timings ?? {}) };
  try {
    let startedAt = Date.now();
    let durationSec: number | null;
    let channels: number | null = state.channelsIn ?? null;
    if (await exists(source)) {
      const info = await probe(source);
      channels = info.channels;
      await transcode(source, out16k, pcm, info.durationSec);
      durationSec = info.durationSec;
      await removeFile(source); // 原始音频（可能是双声道、带他人原声）转码后立即删除
      timings.transcodeMs = Date.now() - startedAt;
    } else if ((await exists(out16k)) && (await exists(pcm))) {
      durationSec = (await probe(out16k)).durationSec; // 上次转码成功、上传临时存储失败后的重试
    } else {
      throw new JobError("NOT_FOUND", 404, "音频文件已不在服务器上，请重新上传");
    }
    durationSec ??= (await stat(pcm)).size / 2 / 8000;

    startedAt = Date.now();
    const plans = planParts(durationSec);
    const parts: UploadPart[] = [];

    // 声纹注册：把注册音频转成和正文一样的 16k 单声道，然后拼到**每一个**分段前面。
    // speakerKey 是按分段隔离的（`${partIndex}:${speakerId}`），只拼在整段最前面的话，
    // 后面的分段找不到"我"，会被全判成别人。
    let enroll16k: string | null = null;
    if (state.enrollMs && (await exists(enrollSourcePath(uploadId)))) {
      try {
        const target = enroll16kPath(uploadId);
        await transcode(enrollSourcePath(uploadId), target, `${target}.pcm`, state.enrollMs / 1000);
        await removeFile(`${target}.pcm`);
        await removeFile(enrollSourcePath(uploadId));
        enroll16k = target;
      } catch {
        enroll16k = null; // 注册段处理不了就当没有，退回响度，不能让整条链路失败
      }
    }

    for (const plan of plans) {
      let file = out16k;
      if (plans.length > 1) {
        file = path.join(uploadDir(uploadId), `part${plan.partIndex}.m4a`);
        await cutPart(out16k, file, plan.offsetSec, plan.lengthSec);
      }
      let submit = file;
      if (enroll16k) {
        submit = path.join(uploadDir(uploadId), `part${plan.partIndex}-enroll.m4a`);
        try {
          await prependAudio(enroll16k, file, submit);
        } catch {
          submit = file; // 这一段拼不上就按原样提交，该段退回响度
        }
      }
      const ossUrl = await uploadToTempStorage(submit);
      parts.push({ partIndex: plan.partIndex, ossUrl, offsetMs: Math.round(plan.offsetSec * 1000), durationMs: Math.round(plan.lengthSec * 1000) });
      if (submit !== file) await removeFile(submit);
      if (plans.length > 1) await removeFile(file);
    }
    if (enroll16k) await removeFile(enroll16k);
    await removeFile(out16k); // 已进百炼临时存储，本地不留
    timings.tempStorageMs = Date.now() - startedAt;
    await patchState(uploadId, { phase: "prepared", durationSec, channelsIn: channels ?? undefined, parts, timings });
  } catch (error) {
    const code = error instanceof FfmpegError || error instanceof BailianError || error instanceof JobError ? error.code : "PREPARE_FAILED";
    await patchState(uploadId, {
      phase: "failed",
      failedAt: "prepare",
      error: { code, message: String((error as Error)?.message ?? error).slice(0, 200) },
      timings,
    }).catch(() => undefined);
    console.error(JSON.stringify({ event: "memo_prepare_failed", code }));
  }
}

export async function prepareStatus(uploadId: string, deviceId: string): Promise<{
  status: "running" | "done" | "failed";
  durationSec?: number;
  channelsIn?: number;
  parts?: UploadPart[];
  error?: { code: string; message: string };
}> {
  let state = await loadOwned(uploadId, deviceId);
  if ((state.phase === "preparing" || state.phase === "assembled") && !preparing.has(uploadId)) {
    // 进程重启（pm2 restart）导致转码任务丢失：安全重跑，不产生识别费用
    console.info(JSON.stringify({ event: "memo_prepare_resumed" }));
    state = await patchState(uploadId, { phase: "assembled" });
    state = await startPrepare(uploadId, deviceId);
  }
  if (state.phase === "failed" && state.failedAt === "prepare") return { status: "failed", error: state.error };
  if (state.parts?.length) return { status: "done", durationSec: state.durationSec, channelsIn: state.channelsIn, parts: state.parts };
  return { status: "running" };
}

// ── 识别 ──────────────────────────────────────────────────────────────

const submitting = new Map<string, Promise<string[]>>();

export async function startTranscribe(uploadId: string, deviceId: string, force = false): Promise<{ taskIds: string[]; reused: boolean }> {
  const state = await loadOwned(uploadId, deviceId);
  const parts = state.parts;
  if (!parts?.length) throw new JobError("NOT_PREPARED", 409, "音频还没准备好");
  const existing = state.taskIds ?? [];
  if (existing.length === parts.length && existing.every(Boolean)) return { taskIds: existing, reused: true };
  const inflight = submitting.get(uploadId);
  if (inflight) return { taskIds: await inflight, reused: true };
  if (state.phase === "submitting" && !force) {
    throw new JobError("ASR_SUBMIT_UNKNOWN", 409, "上次提交语音识别时连接中断，不确定是否已经提交。重新提交可能重复计费（约 0.013 元/分钟录音）。", { canForce: true });
  }

  const job = (async () => {
    await patchState(uploadId, { phase: "submitting", error: undefined, failedAt: undefined });
    const ids = parts.map((_, i) => existing[i] ?? "");
    for (const part of parts) {
      if (ids[part.partIndex]) continue;
      ids[part.partIndex] = await submitTranscription(part.ossUrl);
      await patchState(uploadId, { taskIds: ids }); // 每提交一段立刻落盘
    }
    await patchState(uploadId, { phase: "submitted", taskIds: ids });
    return ids;
  })()
    .catch(async (error) => {
      const bailian = error instanceof BailianError ? error : null;
      if (!bailian?.uncertain) {
        await patchState(uploadId, { phase: "failed", failedAt: "submit", error: { code: bailian?.code ?? "ASR_SUBMIT_FAILED", message: String(error?.message ?? error).slice(0, 200) } }).catch(() => undefined);
      }
      // uncertain：状态保持 submitting，下次必须 force
      throw new JobError(bailian?.uncertain ? "ASR_SUBMIT_UNKNOWN" : "ASR_SUBMIT_FAILED", 502, bailian?.uncertain ? "提交语音识别时连接中断，结果不明" : "提交语音识别失败，可以重试", bailian?.uncertain ? { canForce: true } : undefined);
    })
    .finally(() => submitting.delete(uploadId));
  submitting.set(uploadId, job);
  return { taskIds: await job, reused: false };
}

export interface TranscribeStatus {
  status: "running" | "succeeded" | "failed";
  sentences?: { partIndex: number; beginMs: number; endMs: number; speakerId: string; speakerKey: string; text: string }[];
  speakers?: { key: string; meanDb: number | null; talkMs: number }[];
  /** 服务端临时文件已不在（例如结果已取过、被清理），算不出响度，前端需要让用户确认"我" */
  speakersDegraded?: boolean;
  /** 用了声纹注册时，每个分段里注册段所属的 speakerKey —— 这些就是"我"。为空表示没识别出来 */
  meSpeakerKeys?: string[];
  asrSeconds?: number;
  asrModel?: string;
  asrCostYuan?: number;
  error?: { code: string; message: string };
}

const completing = new Map<string, Promise<TranscribeStatus>>();

export async function transcribeStatus(input: { uploadId: string; deviceId: string; taskIds?: string[]; offsets?: number[] }): Promise<TranscribeStatus> {
  const state = await readState(input.uploadId);
  if (state && state.deviceId !== input.deviceId) throw new JobError("NOT_FOUND", 404, "上传任务不存在");
  const taskIds = state?.taskIds?.length ? state.taskIds : input.taskIds;
  if (!taskIds?.length || taskIds.some((id) => !id)) throw new JobError("NOT_FOUND", 404, "没有识别任务，请重新提交");
  const offsets = state?.parts?.map((p) => p.offsetMs) ?? input.offsets ?? taskIds.map(() => 0);

  const statuses = await Promise.all(taskIds.map((id) => queryTask(id)));
  const failed = statuses.find((s) => s.status === "FAILED");
  if (failed) {
    if (state) await patchState(input.uploadId, { phase: "failed", failedAt: "asr", error: { code: "ASR_FAILED", message: failed.errorCode ?? "" } }).catch(() => undefined);
    return { status: "failed", error: { code: "ASR_FAILED", message: `语音识别失败（${failed.errorCode ?? "未知原因"}）` } };
  }
  if (!statuses.every((s) => s.status === "SUCCEEDED")) {
    if (state) await patchState(input.uploadId, {}).catch(() => undefined);
    return { status: "running" };
  }

  const pending = completing.get(input.uploadId);
  if (pending) return pending;
  const job = (async (): Promise<TranscribeStatus> => {
    const sentences: NonNullable<TranscribeStatus["sentences"]> = [];
    // 声纹注册：每段开头那 enrollMs 毫秒是注册音频。它落在哪个 speakerId 上，那个就是这一段的"我"。
    // 注册段本身必须从逐字稿里剥掉，剩下的句子整体减去 enrollMs 才回到真实录音的时间轴。
    const enrollMs = state?.enrollMs ?? 0;
    const meSpeakerKeys: string[] = [];
    let maxEnd = 0;
    for (let i = 0; i < statuses.length; i += 1) {
      const s = statuses[i];
      if (s.empty || !s.transcriptionUrl) continue;
      const result = await fetchTranscription(s.transcriptionUrl);

      if (enrollMs > 0) {
        // 注册段里说话时长最多的那个 speakerId 就是"我"（容忍 ASR 把边界切得略偏）
        const talk = new Map<string, number>();
        for (const sentence of result.sentences) {
          if (sentence.beginMs >= enrollMs) continue;
          const ms = Math.min(sentence.endMs, enrollMs) - sentence.beginMs;
          if (ms > 0) talk.set(sentence.speakerId, (talk.get(sentence.speakerId) ?? 0) + ms);
        }
        let best: string | null = null;
        let bestMs = 0;
        for (const [id, ms] of talk) if (ms > bestMs) { best = id; bestMs = ms; }
        if (best !== null) meSpeakerKeys.push(`${i}:${best}`);
      }

      for (const sentence of result.sentences) {
        // 整句落在注册段里 → 丢掉，它不是用户这次说的话
        if (enrollMs > 0 && sentence.endMs <= enrollMs) continue;
        const beginMs = Math.max(0, sentence.beginMs - enrollMs) + (offsets[i] ?? 0);
        const endMs = Math.max(0, sentence.endMs - enrollMs) + (offsets[i] ?? 0);
        if (endMs <= beginMs) continue;
        maxEnd = Math.max(maxEnd, endMs);
        sentences.push({ partIndex: i, beginMs, endMs, speakerId: sentence.speakerId, speakerKey: `${i}:${sentence.speakerId}`, text: sentence.text });
      }
    }
    sentences.sort((a, b) => a.beginMs - b.beginMs);

    let speakers: TranscribeStatus["speakers"];
    let speakersDegraded = false;
    try {
      if (!state) throw new Error("no state");
      const buf = await readFile(pcm8kPath(input.uploadId));
      const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.byteLength / 2) * 2));
      speakers = speakerLoudness(samples, 8000, sentences);
    } catch {
      speakersDegraded = true;
      speakers = speakerLoudness(new Int16Array(0), 8000, sentences);
    }

    const asrSeconds = Math.round(state?.durationSec ?? maxEnd / 1000);
    const model = asrModel();
    // D11：拿到转写结果立即删除该会话所有服务端临时文件
    if (state) await removeUpload(input.uploadId);
    return { status: "succeeded", sentences, speakers, speakersDegraded, ...(meSpeakerKeys.length ? { meSpeakerKeys } : {}), asrSeconds, asrModel: model, asrCostYuan: asrCostYuan(model, asrSeconds).yuan };
  })().finally(() => setTimeout(() => completing.delete(input.uploadId), 30_000));
  completing.set(input.uploadId, job);
  return job;
}
