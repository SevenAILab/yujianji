"use client";

// App 内录音（spec §4.10）：MediaRecorder 每 10 秒吐一块，立刻写进 IndexedDB；锁屏/切后台记中断；
// 开始时取一次定位，前台时每 5 分钟再取，每次写一条时间轴事件（D1）。
import { db } from "../../db";
import { addTimelineEvent } from "./repo";
import { reverseGeocode, samplePosition } from "./location";

export const TIMESLICE_MS = 10_000;
export const LOCATION_INTERVAL_MS = 5 * 60_000;

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

export function recordingSupported(): { ok: boolean; reason?: string } {
  if (typeof window === "undefined") return { ok: false, reason: "不在浏览器里" };
  if (!window.isSecureContext) return { ok: false, reason: "录音需要 HTTPS。局域网 http 地址只能用「导入录音」。" };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "这个浏览器不支持网页录音，请用「导入录音」。" };
  if (typeof MediaRecorder === "undefined") return { ok: false, reason: "这个浏览器不支持 MediaRecorder，请用「导入录音」。" };
  return { ok: true };
}

export interface RecorderEvents {
  onChunk?: (index: number, bytes: number) => void;
  onInterruption?: (atIso: string) => void;
  onResume?: () => void;
  onLocation?: (place: string | null) => void;
  onWakeLock?: (held: boolean) => void;
}

export class MemoRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private locationTimer: ReturnType<typeof setInterval> | null = null;
  private chunkIndex = 0;
  private pendingWrites: Promise<unknown>[] = [];
  readonly interruptions: string[] = [];
  mimeType = "";
  startedAt = "";

  constructor(private readonly sessionId: string, private readonly events: RecorderEvents = {}) {}

  async start(): Promise<void> {
    const support = recordingSupported();
    if (!support.ok) throw new Error(support.reason);
    // 关掉自动增益和降噪：保留"我离手机近、声音更响"的差别，定"我"靠它
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
    this.mimeType = this.recorder.mimeType || mimeType || "audio/mp4";
    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const index = this.chunkIndex++;
      const write = db.memoChunks.put({ sessionId: this.sessionId, index, blob: event.data, createdAt: new Date().toISOString() });
      this.pendingWrites.push(write);
      void write.then(() => this.events.onChunk?.(index, event.data.size));
    };
    this.recorder.start(TIMESLICE_MS);
    this.startedAt = new Date().toISOString();

    document.addEventListener("visibilitychange", this.handleVisibility);
    await this.acquireWakeLock();
    void this.sampleLocation();
    this.locationTimer = setInterval(() => {
      if (document.visibilityState === "visible") void this.sampleLocation();
    }, LOCATION_INTERVAL_MS);
  }

  private handleVisibility = () => {
    if (document.visibilityState === "hidden") {
      const at = new Date().toISOString();
      this.interruptions.push(at);
      this.events.onInterruption?.(at);
    } else {
      this.events.onResume?.();
      void this.acquireWakeLock();
    }
  };

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
      if (!nav.wakeLock) {
        this.events.onWakeLock?.(false);
        return;
      }
      this.wakeLock = await nav.wakeLock.request("screen");
      this.events.onWakeLock?.(true);
    } catch {
      this.events.onWakeLock?.(false);
    }
  }

  private async sampleLocation(): Promise<void> {
    const position = await samplePosition();
    if (!position) {
      this.events.onLocation?.(null);
      return;
    }
    const named = await reverseGeocode(position);
    await addTimelineEvent({
      kind: "location",
      startAt: new Date().toISOString(),
      refId: "",
      sessionId: this.sessionId,
      lat: position.lat,
      lng: position.lng,
      accuracyM: position.accuracyM,
      placeName: named?.place,
      source: "gps",
    });
    this.events.onLocation?.(named?.place ?? null);
  }

  async stop(): Promise<{ blob: Blob; mimeType: string; startedAt: string; endedAt: string; interruptions: string[] }> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    await Promise.allSettled(this.pendingWrites);
    this.release();
    const blob = await mergeChunks(this.sessionId, this.mimeType);
    return { blob: blob ?? new Blob([], { type: this.mimeType }), mimeType: this.mimeType, startedAt: this.startedAt, endedAt: new Date().toISOString(), interruptions: [...this.interruptions] };
  }

  release(): void {
    document.removeEventListener("visibilitychange", this.handleVisibility);
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}

/** 把已存的分块按序合并（停止录音时，或刷新页面后恢复） */
export async function mergeChunks(sessionId: string, mimeType?: string): Promise<Blob | null> {
  const chunks = await db.memoChunks.where("sessionId").equals(sessionId).sortBy("index");
  if (!chunks.length) return null;
  return new Blob(chunks.map((c) => c.blob), { type: mimeType || chunks[0].blob.type || "audio/mp4" });
}
