"use client";

import { dataUrlByteLength } from "./image";
import type { AvFrame } from "./types";

const MAX_VIDEO_SECONDS = 60;
const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FRAME_TOTAL_BYTES = 1_100_000;
export const MAX_AV_REQUEST_BYTES = 4_200_000;

type AvExtractionErrorCode =
  | "VIDEO_TOO_LONG"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_READ_ERROR"
  | "UNSUPPORTED_CODEC"
  | "DECODE_TIMEOUT"
  | "NO_AUDIO"
  | "FRAMES_TOO_LARGE"
  | "AUDIO_TOO_LARGE"
  | "REQUEST_TOO_LARGE";

export class AvExtractionError extends Error {
  code: AvExtractionErrorCode;

  constructor(code: AvExtractionErrorCode, message: string) {
    super(message);
    this.name = "AvExtractionError";
    this.code = code;
  }
}

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: AvExtractionErrorCode,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new AvExtractionError(code, message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () =>
      reject(new AvExtractionError("VIDEO_READ_ERROR", "视频读取失败"));
  });
}

function seekVideo(video: HTMLVideoElement, atSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () =>
      reject(new AvExtractionError("UNSUPPORTED_CODEC", "浏览器无法解码这段视频"));
    video.currentTime = atSec;
  });
}

function drawFrame(
  video: HTMLVideoElement,
  maxEdge: number,
  quality: number,
): string {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new AvExtractionError("VIDEO_READ_ERROR", "浏览器无法创建抽帧画布");
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  canvas.width = 1;
  canvas.height = 1;
  return dataUrl;
}

function captureBudgetedFrame(
  video: HTMLVideoElement,
  maxBytes: number,
): string {
  for (const [maxEdge, quality] of [
    [960, 0.8],
    [960, 0.7],
    [840, 0.68],
    [720, 0.64],
  ] as const) {
    const dataUrl = drawFrame(video, maxEdge, quality);
    if (dataUrlByteLength(dataUrl) <= maxBytes) return dataUrl;
  }
  throw new AvExtractionError("FRAMES_TOO_LARGE", "视频画面过于复杂，压缩后仍然太大");
}

function audioBufferHasSignal(buffer: AudioBuffer, durationSec: number): boolean {
  const channel = buffer.getChannelData(0);
  const limit = Math.min(channel.length, Math.ceil(durationSec * buffer.sampleRate));
  let peak = 0;
  let energy = 0;
  const step = Math.max(1, Math.floor(limit / 160_000));
  let count = 0;
  for (let index = 0; index < limit; index += step) {
    const sample = Math.abs(channel[index] ?? 0);
    peak = Math.max(peak, sample);
    energy += sample * sample;
    count += 1;
  }
  return peak > 0.002 || Math.sqrt(energy / Math.max(1, count)) > 0.0002;
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const pcm = buffer.getChannelData(0);
  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(wav);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return wav;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("音频编码失败"));
    reader.onerror = () => reject(new Error("音频编码失败"));
    reader.readAsDataURL(blob);
  });
}

export function calculateFrameTimes(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (durationSec < 0.6) return [Number((durationSec / 2).toFixed(3))];
  const frameCount = Math.min(6, Math.max(1, Math.ceil(durationSec / 4)));
  const start = 0.3;
  const end = Math.max(start, durationSec - 0.3);
  if (frameCount === 1) return [Number(((start + end) / 2).toFixed(3))];
  return Array.from({ length: frameCount }, (_, index) =>
    Number((start + ((end - start) * index) / (frameCount - 1)).toFixed(3)),
  );
}

export function getEffectiveVideoDuration(
  durationSec: number,
  maxSeconds = MAX_VIDEO_SECONDS,
): { durationSec: number; truncated: boolean } {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { durationSec: 0, truncated: false };
  }
  const effectiveMax = Math.max(0.1, maxSeconds);
  return {
    durationSec: Math.min(durationSec, effectiveMax),
    truncated: durationSec > effectiveMax,
  };
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function extractFramesAndAudio(
  file: File,
  opts: { maxSeconds?: number } = {},
): Promise<{
  frames: AvFrame[];
  audioDataUrl: string;
  durationSec: number;
  truncated: boolean;
}> {
  const maxSeconds = opts.maxSeconds ?? MAX_VIDEO_SECONDS;
  if (file.size > MAX_VIDEO_FILE_BYTES) {
    throw new AvExtractionError(
      "VIDEO_TOO_LARGE",
      "视频文件超过 100MB，请先在相册里截短后再试",
    );
  }

  const AudioContextConstructor =
    window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new AvExtractionError(
      "UNSUPPORTED_CODEC",
      "这台设备暂时不能处理视频声音",
    );
  }
  const audioContext = new AudioContextConstructor();
  void audioContext.resume();

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  try {
    await withTimeout(
      waitForMetadata(video),
      8_000,
      "DECODE_TIMEOUT",
      "读取视频信息超时",
    );
    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new AvExtractionError("VIDEO_READ_ERROR", "无法读取视频时长");
    }
    const effectiveDuration = getEffectiveVideoDuration(durationSec, maxSeconds);
    if (!video.videoWidth || !video.videoHeight) {
      throw new AvExtractionError(
        "UNSUPPORTED_CODEC",
        "浏览器无法读取这段视频的画面编码",
      );
    }

    const frameTimes = calculateFrameTimes(effectiveDuration.durationSec);
    const frameBudget = Math.floor(MAX_FRAME_TOTAL_BYTES / frameTimes.length);
    const frames: AvFrame[] = [];
    for (const atSec of frameTimes) {
      await withTimeout(
        seekVideo(video, atSec),
        8_000,
        "DECODE_TIMEOUT",
        "抽取视频画面超时",
      );
      frames.push({
        dataUrl: captureBudgetedFrame(video, frameBudget),
        atSec,
      });
    }

    const sourceBuffer = await withTimeout(
      file.arrayBuffer(),
      12_000,
      "DECODE_TIMEOUT",
      "读取视频声音超时",
    );
    let decoded: AudioBuffer;
    try {
      decoded = await withTimeout(
        audioContext.decodeAudioData(sourceBuffer),
        15_000,
        "DECODE_TIMEOUT",
        "解码视频声音超时",
      );
    } catch (error) {
      if (error instanceof AvExtractionError) throw error;
      throw new AvExtractionError(
        "UNSUPPORTED_CODEC",
        "浏览器无法解码这段视频的声音",
      );
    }
    const decodedDuration = Math.min(
      effectiveDuration.durationSec,
      decoded.duration,
    );
    if (!decoded.numberOfChannels || decodedDuration <= 0.05) {
      throw new AvExtractionError("NO_AUDIO", "这段视频里没有可识别的声音");
    }
    if (!audioBufferHasSignal(decoded, decodedDuration)) {
      throw new AvExtractionError("NO_AUDIO", "这段视频里没有可识别的声音");
    }

    const offline = new OfflineAudioContext(
      1,
      Math.ceil(decodedDuration * 16_000),
      16_000,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, 0, decodedDuration);
    const rendered = await withTimeout(
      offline.startRendering(),
      12_000,
      "DECODE_TIMEOUT",
      "处理视频声音超时",
    );
    const wav = encodeWav(rendered);
    if (wav.byteLength > 1_950_000) {
      throw new AvExtractionError("AUDIO_TOO_LARGE", "视频声音压缩后仍然太大");
    }
    return {
      frames,
      audioDataUrl: await blobToDataUrl(new Blob([wav], { type: "audio/wav" })),
      durationSec,
      truncated: effectiveDuration.truncated,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
    void audioContext.close();
  }
}
