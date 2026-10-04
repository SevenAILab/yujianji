// 飞书妙记 → 遇见手记的转写结果（外部设备接入工单 v2 Gate 1）。
// 产出和 jobs.ts 的 TranscribeStatus 同形，客户端用 ingestExternalTranscript 写进逐字稿，之后的初筛、判断、手帐不感知来源。
// 不调用语音识别（飞书已经转好），费用记 0。音频只用来算响度定"我"：下载到临时目录、算完立刻删。
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { docRawContent, FeishuError, getMinute, mediaUrl, verbatimDocToken, type MinuteInfo } from "../../feishu/api";
import { ownerSpeakerKeys, parseVerbatim, turnsToSentences, type FeishuRecordingTime } from "../feishu-transcript";
import { speakerLoudness } from "../loudness";
import { decodePcm8k } from "./ffmpeg";
import type { TranscribeStatus } from "./jobs";
import { tmpRoot } from "./tmp-store";

/** 单条录音音频的大小上限：Ogg/Opus 约 64 kbps，3 小时约 90MB */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export const FEISHU_ASR_MODEL = "feishu-minutes";

export interface FeishuMinutePreview {
  token: string;
  title: string;
  durationMs: number | null;
  syncedAt: string | null;
  /** 文字记录里的录音时间；读不到为 null，前端必须让用户确认 */
  recording: FeishuRecordingTime | null;
  turns: number;
  speakers: number;
}

async function loadVerbatim(userToken: string, minuteToken: string): Promise<{ info: MinuteInfo; raw: string }> {
  const info = await getMinute(userToken, minuteToken);
  if (!info.noteId) throw new FeishuError("FEISHU_NOT_READY", 409, "这条妙记还没有生成文字记录（飞书可能还在整理），稍后再试");
  const docToken = await verbatimDocToken(userToken, info.noteId);
  const raw = await docRawContent(userToken, docToken);
  return { info, raw };
}

export async function previewMinute(userToken: string, minuteToken: string): Promise<FeishuMinutePreview> {
  const { info, raw } = await loadVerbatim(userToken, minuteToken);
  const parsed = parseVerbatim(raw);
  return {
    token: minuteToken,
    title: info.title,
    durationMs: info.durationMs,
    syncedAt: info.syncedAt,
    recording: parsed.recording,
    turns: parsed.turns.length,
    speakers: new Set(parsed.turns.map((t) => t.speakerId)).size,
  };
}

async function downloadMedia(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new FeishuError("FEISHU_ERROR", 502, `下载录音失败 HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw new FeishuError("FEISHU_MEDIA_TOO_LARGE", 413, "这段录音太大，暂时处理不了");
  let received = 0;
  const limited = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_MEDIA_BYTES) limited.destroy(new FeishuError("FEISHU_MEDIA_TOO_LARGE", 413, "这段录音太大，暂时处理不了"));
  });
  await pipeline(limited, createWriteStream(file));
}

export type FeishuTranscript = TranscribeStatus & { status: "succeeded"; title: string; recording: FeishuRecordingTime | null; durationMs: number | null };

/**
 * 全量：文字记录 → 句子时间轴；下载音频 → 按说话人算响度。
 * 音频那一步失败（ffmpeg 没装、下载失败）不拦导入：speakersDegraded=true，前端让用户自己勾"我"。
 */
export async function transcriptFromMinute(userToken: string, minuteToken: string, ownerNames: string[]): Promise<FeishuTranscript> {
  const { info, raw } = await loadVerbatim(userToken, minuteToken);
  const parsed = parseVerbatim(raw);
  if (!parsed.turns.length) throw new FeishuError("FEISHU_NOT_READY", 409, "文字记录是空的（可能还在整理，或这段没有说话）");
  const sentences = turnsToSentences(parsed.turns, info.durationMs);
  const meSpeakerKeys = ownerSpeakerKeys(parsed.turns, ownerNames);

  const dir = path.join(tmpRoot(), `feishu_${randomUUID()}`);
  const media = path.join(dir, "media.ogg");
  const pcm = path.join(dir, "audio.s16le");
  let speakers: TranscribeStatus["speakers"];
  let speakersDegraded = false;
  try {
    await mkdir(dir, { recursive: true });
    await downloadMedia(await mediaUrl(userToken, minuteToken), media);
    await decodePcm8k(media, pcm, info.durationMs ? info.durationMs / 1000 : null);
    const buf = await readFile(pcm);
    const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.byteLength / 2) * 2));
    speakers = speakerLoudness(samples, 8000, sentences);
  } catch (error) {
    if (error instanceof FeishuError && error.code === "FEISHU_AUTH_EXPIRED") throw error;
    console.error(JSON.stringify({ event: "feishu_loudness_degraded", code: (error as { code?: string })?.code ?? (error as Error)?.name ?? "unknown" }));
    speakersDegraded = true;
    speakers = speakerLoudness(new Int16Array(0), 8000, sentences);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  const asrSeconds = Math.round((info.durationMs ?? sentences.at(-1)?.endMs ?? 0) / 1000);
  return {
    status: "succeeded",
    sentences,
    speakers,
    speakersDegraded,
    ...(meSpeakerKeys.length ? { meSpeakerKeys } : {}),
    asrSeconds,
    asrModel: FEISHU_ASR_MODEL,
    asrCostYuan: 0,
    title: info.title,
    recording: parsed.recording,
    durationMs: info.durationMs,
  };
}
