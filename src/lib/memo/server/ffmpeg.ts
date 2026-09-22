// 转码：统一转单声道 16kHz AAC 给语音识别（说话人分离只支持单声道，D2），另出一份 8kHz PCM 算响度。
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 超过 110 分钟按时长切成多段分别提交（官方建议开说话人分离时 ≤ 2 小时） */
export const PART_MAX_SEC = 110 * 60;

export class FfmpegError extends Error {
  readonly code: "FFMPEG_UNAVAILABLE" | "FFMPEG_FAILED";
  constructor(code: FfmpegError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError("FFMPEG_FAILED", `${path.basename(bin)} 超过 ${Math.round(timeoutMs / 1000)} 秒`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < 64_000) stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new FfmpegError(error.code === "ENOENT" ? "FFMPEG_UNAVAILABLE" : "FFMPEG_FAILED", error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError("FFMPEG_FAILED", stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)));
    });
  });
}

let availability: { ok: boolean; at: number } | null = null;

export async function ffmpegAvailable(): Promise<boolean> {
  if (availability && Date.now() - availability.at < 60_000) return availability.ok;
  try {
    await run(ffmpegPath(), ["-version"], 10_000);
    availability = { ok: true, at: Date.now() };
  } catch {
    availability = { ok: false, at: Date.now() };
  }
  return availability.ok;
}

/** 从 ffmpeg -i 的 stderr 里读时长和声道（不依赖 ffprobe） */
export function parseProbe(stderr: string): { durationSec: number | null; channels: number | null } {
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const audio = stderr.match(/Audio:[^\n]*/)?.[0] ?? "";
  const channels = /\bmono\b/.test(audio) ? 1 : /\bstereo\b/.test(audio) ? 2 : Number(audio.match(/(\d+) channels/)?.[1] ?? NaN) || null;
  return { durationSec, channels };
}

/** ffmpeg -i 不带输出时退出码非 0，时长和声道信息在 stderr 里 */
export async function probe(input: string): Promise<{ durationSec: number | null; channels: number | null }> {
  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ["-hide_banner", "-i", input], { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.stderr.on("data", (d) => {
      out = (out + d).slice(-16_000);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    proc.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new FfmpegError(error.code === "ENOENT" ? "FFMPEG_UNAVAILABLE" : "FFMPEG_FAILED", error.message));
    });
  });
  return parseProbe(stderr);
}

/** 一次 ffmpeg 同时产出：16kHz 单声道 AAC（识别）+ 8kHz 单声道 s16le PCM（响度） */
export async function transcode(input: string, out16k: string, outPcm8k: string, durationSec: number | null): Promise<void> {
  const timeoutMs = Math.max(60_000, (durationSec ?? 600) * 1000 * 0.5);
  await run(
    ffmpegPath(),
    ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", out16k, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", outPcm8k],
    timeoutMs,
  );
}

export function planParts(durationSec: number, maxSec = PART_MAX_SEC): { partIndex: number; offsetSec: number; lengthSec: number }[] {
  const count = Math.max(1, Math.ceil(durationSec / maxSec));
  return Array.from({ length: count }, (_, partIndex) => {
    const offsetSec = partIndex * maxSec;
    return { partIndex, offsetSec, lengthSec: Math.min(maxSec, durationSec - offsetSec) };
  });
}

export async function cutPart(input16k: string, output: string, offsetSec: number, lengthSec: number): Promise<void> {
  await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(offsetSec), "-t", String(lengthSec), "-i", input16k, "-c", "copy", output], 120_000);
}

/**
 * 把 prefix 拼到 input 前面。两个文件都由 transcode() 产出（16k 单声道 AAC），
 * 参数一致才能 -c copy，不重新编码。用于给每个 ASR 分段都带上声纹注册段。
 */
export async function prependAudio(prefix: string, input: string, output: string): Promise<void> {
  const list = `${output}.concat.txt`;
  const esc = (p: string) => p.replace(/'/g, "'\\''");
  await writeFile(list, `file '${esc(path.resolve(prefix))}'\nfile '${esc(path.resolve(input))}'\n`, "utf8");
  try {
    await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output], 120_000);
  } finally {
    await rm(list, { force: true });
  }
}
