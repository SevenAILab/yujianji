"use client";

// 导入手机自带录音 App 的文件：读 mvhd 录制时间和时长；读不到就让用户确认开始时间（spec §4.10）。
import { readMvhdFromBlob } from "../mvhd";

export interface InspectedAudio {
  mime: string;
  durationSec: number | null;
  /** mvhd.creation_time：通常等于开录时间，但不保证，页面上必须可改 */
  creationTime: string | null;
  /** 文件修改时间，只作为读不到录制时间时的预填，标明"可能不准" */
  lastModified: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  caf: "audio/x-caf",
};

export function guessMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function readDurationViaAudio(blob: Blob, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    const done = (value: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

export async function inspectAudioFile(file: File): Promise<InspectedAudio> {
  const mvhd = await readMvhdFromBlob(file).catch(() => null);
  const durationSec = mvhd?.durationSec ?? (await readDurationViaAudio(file));
  return {
    mime: guessMime(file),
    durationSec: durationSec ? Math.round(durationSec) : null,
    creationTime: mvhd?.creationTime ?? null,
    lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  };
}

/** datetime-local 输入框的值（本地时间）↔ ISO */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string | null {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
