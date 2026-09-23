"use client";

// 全局录音（工单 Gate 2.1）：录音器挂在根布局上，切页面不断——这是"录着音去首页拍照"的前提。
//
// 约束（Codex 审核 #8）：
// - 全站只有一个 MemoRecorder，不在空闲时再 start() 直接忽略
// - 分块照旧每 10 秒写进 IndexedDB；Blob 只在 stop() 的局部变量里过一下，不进 React state
// - 刷新、关页面：会话停在 recording，旅途页「今天」卡和 /memo 页提供「处理已录下的部分」（recoverRecording）
// - beforeunload 只是提醒，不是保存手段
// - 停止后在后台跑管线到 ready，不写手帐（手帐日终统一生成）
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { createSession, finalizeAudio, runPipeline } from "@/lib/memo/client/orchestrator";
import { MemoRecorder, recordingSupported } from "@/lib/memo/client/recorder";
import { deleteSession, patchSession } from "@/lib/memo/client/repo";
import { effectiveDecision } from "@/lib/memo/select";
import { DiaryAutoGenerator } from "./DiaryAutoGenerator";
import { RecordingPill } from "./RecordingPill";

export type RecorderKind = "in_app" | "backfill";

export interface RecordingState {
  phase: "idle" | "starting" | "recording" | "stopping";
  kind: RecorderKind;
  sessionId?: string;
  startedAtMs?: number;
  chunks: number;
  interruptions: number;
  place?: string | null;
  wakeLock?: boolean | null;
  error?: string;
}

/** 停止之后在后台处理的一段录音 */
export interface RecorderJob {
  sessionId: string;
  status: "processing" | "done" | "error";
  message: string;
  /** 处理完、有留下的内容时，它属于哪一天 */
  dayKey?: string;
  finishedAt?: number;
}

export interface RecorderApi {
  enabled: boolean;
  supported: { ok: boolean; reason?: string };
  recording: RecordingState;
  jobs: RecorderJob[];
  /** 还没注册声纹：录音时给一条可关闭的提示 */
  needsEnroll: boolean;
  start: (kind?: RecorderKind) => Promise<void>;
  stop: () => Promise<void>;
  /** 处理一段没正常结束（刷新/关页面）或失败的录音 */
  process: (sessionId: string) => Promise<void>;
  isActive: (sessionId: string) => boolean;
  dismissEnroll: () => void;
  clearError: () => void;
}

const RESUMABLE = ["recorded", "uploading", "preparing", "transcribing", "judging"];
const IDLE: RecordingState = { phase: "idle", kind: "in_app", chunks: 0, interruptions: 0 };
const ENROLL_DISMISSED_KEY = "memo-enroll-hint-dismissed";

const RecorderContext = createContext<RecorderApi | null>(null);

export function useRecorder(): RecorderApi {
  const value = useContext(RecorderContext);
  if (!value) throw new Error("useRecorder 必须在 RecorderProvider 里用");
  return value;
}

export function RecorderProvider({ children }: { children: ReactNode }) {
  const enabled = !LOCAL_ONLY;
  const [supported, setSupported] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [recording, setRecording] = useState<RecordingState>(IDLE);
  const [jobs, setJobs] = useState<RecorderJob[]>([]);
  const [needsEnroll, setNeedsEnroll] = useState(false);
  const recorderRef = useRef<MemoRecorder | null>(null);
  const busyRef = useRef(false);
  const placeRef = useRef<string | null>(null);
  const sessionRef = useRef<string | undefined>(undefined);
  const processingRef = useRef(new Set<string>());

  useEffect(() => setSupported(recordingSupported()), []);

  // 录音中关页面：提醒一下（浏览器会弹原生确认框）。已录的分块都在 IndexedDB 里，不靠它保存。
  useEffect(() => {
    if (recording.phase !== "recording") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording.phase]);

  useEffect(() => () => recorderRef.current?.release(), []);

  const updateJob = useCallback((sessionId: string, patch: Partial<RecorderJob>) => {
    setJobs((list) => {
      const rest = list.filter((j) => j.sessionId !== sessionId);
      const current = list.find((j) => j.sessionId === sessionId) ?? { sessionId, status: "processing" as const, message: "开始处理" };
      return [...rest, { ...current, ...patch }].slice(-5);
    });
  }, []);

  const process = useCallback(
    async (sessionId: string) => {
      if (processingRef.current.has(sessionId)) return;
      processingRef.current.add(sessionId);
      updateJob(sessionId, { status: "processing", message: "开始处理", finishedAt: undefined });
      try {
        const final = await runPipeline(sessionId, {
          autoDiary: false,
          retry: true,
          onProgress: (p) => updateJob(sessionId, { status: "processing", message: p.message }),
        });
        if (final.status === "ready") {
          const moments = await db.moments.where("sessionId").equals(sessionId).toArray();
          const kept = moments.filter((m) => effectiveDecision(m) === "keep");
          updateJob(sessionId, {
            status: "done",
            message: kept.length ? `留下 ${kept.length} 段，一天结束时写进手帐` : "这段没有需要留下的话",
            dayKey: kept[0]?.dayKey,
            finishedAt: Date.now(),
          });
        } else {
          updateJob(sessionId, { status: "error", message: final.error?.message ?? "处理没有完成", finishedAt: Date.now() });
        }
      } catch (cause) {
        updateJob(sessionId, { status: "error", message: describeMemoError(cause), finishedAt: Date.now() });
      } finally {
        processingRef.current.delete(sessionId);
      }
    },
    [updateJob],
  );

  // 刷新或重新打开后，把停在半路（已上传/转写/判断中）的录音接着跑完。
  // 停在 recording 的是没正常结束的，要用户确认「处理已录下的部分」，不自动动它。
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!enabled || resumedRef.current) return;
    resumedRef.current = true;
    void db.memoSessions
      .where("status")
      .anyOf(RESUMABLE)
      .toArray()
      .then((sessions) => sessions.forEach((s) => void process(s.id)))
      .catch(() => undefined);
  }, [enabled, process]);

  const start = useCallback(
    async (kind: RecorderKind = "in_app") => {
      if (!enabled || busyRef.current) return; // 全站只有一个录音器
      const support = recordingSupported();
      setSupported(support);
      if (!support.ok) {
        setRecording({ ...IDLE, kind, error: support.reason });
        return;
      }
      busyRef.current = true;
      placeRef.current = null;
      setRecording({ ...IDLE, phase: "starting", kind });
      let createdId: string | undefined;
      try {
        const created = await createSession({ kind, startedAt: new Date().toISOString(), durationSec: 0, startedAtSource: "recorder", status: "recording" });
        createdId = created.id;
        const rec = new MemoRecorder(created.id, {
          onChunk: (index) => setRecording((r) => (r.sessionId === created.id ? { ...r, chunks: index + 1 } : r)),
          onInterruption: () => setRecording((r) => (r.sessionId === created.id ? { ...r, interruptions: r.interruptions + 1 } : r)),
          onLocation: (place) => {
            placeRef.current = place;
            setRecording((r) => (r.sessionId === created.id ? { ...r, place } : r));
          },
          onWakeLock: (held) => setRecording((r) => (r.sessionId === created.id ? { ...r, wakeLock: held } : r)),
        });
        recorderRef.current = rec;
        sessionRef.current = created.id;
        setRecording({ ...IDLE, phase: "starting", kind, sessionId: created.id });
        await rec.start();
        await patchSession(created.id, { startedAt: rec.startedAt });
        setRecording((r) => ({ ...r, phase: "recording", startedAtMs: Date.now() }));
        const enrolled = (await db.memoVoiceprint.count().catch(() => 1)) > 0;
        let dismissed = false;
        try {
          dismissed = sessionStorage.getItem(ENROLL_DISMISSED_KEY) === "1";
        } catch {
          // 隐私模式读不到 sessionStorage，就照常提示
        }
        setNeedsEnroll(!enrolled && !dismissed);
      } catch (cause) {
        recorderRef.current?.release();
        recorderRef.current = null;
        sessionRef.current = undefined;
        if (createdId) await deleteSession(createdId).catch(() => undefined);
        busyRef.current = false;
        const denied = cause instanceof Error && cause.name === "NotAllowedError";
        setRecording({ ...IDLE, kind, error: denied ? "没有麦克风权限。请在浏览器设置里允许，或者改用「导入」。" : describeMemoError(cause) });
      }
    },
    [enabled],
  );

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    const sessionId = sessionRef.current;
    if (!rec || !sessionId) return;
    setRecording((r) => ({ ...r, phase: "stopping" }));
    try {
      const out = await rec.stop();
      recorderRef.current = null;
      sessionRef.current = undefined;
      if (out.blob.size === 0) throw new Error("没有录到声音");
      const durationSec = Math.max(1, Math.round((new Date(out.endedAt).getTime() - new Date(out.startedAt).getTime()) / 1000));
      const place = placeRef.current;
      await finalizeAudio(sessionId, out.blob, out.mimeType, {
        endedAt: out.endedAt,
        durationSec,
        interruptions: out.interruptions,
        ...(place ? { place: { name: place, source: "gps" as const, confidence: "medium" as const } } : {}),
      });
      busyRef.current = false;
      setRecording((r) => ({ ...IDLE, kind: r.kind }));
      setNeedsEnroll(false);
      void process(sessionId);
    } catch (cause) {
      // 分块都还在 IndexedDB 里，会话停在 recording：旅途页可以「处理已录下的部分」
      recorderRef.current?.release();
      recorderRef.current = null;
      sessionRef.current = undefined;
      busyRef.current = false;
      setRecording((r) => ({ ...IDLE, kind: r.kind, error: describeMemoError(cause) }));
    }
  }, [process]);

  const dismissEnroll = useCallback(() => {
    setNeedsEnroll(false);
    try {
      sessionStorage.setItem(ENROLL_DISMISSED_KEY, "1");
    } catch {
      // 存不下就只在这次关掉
    }
  }, []);

  const clearError = useCallback(() => setRecording((r) => ({ ...r, error: undefined })), []);

  const isActive = useCallback((sessionId: string) => sessionRef.current === sessionId || processingRef.current.has(sessionId), []);

  const api = useMemo<RecorderApi>(
    () => ({ enabled, supported, recording, jobs, needsEnroll, start, stop, process, isActive, dismissEnroll, clearError }),
    [enabled, supported, recording, jobs, needsEnroll, start, stop, process, isActive, dismissEnroll, clearError],
  );

  return (
    <RecorderContext.Provider value={api}>
      {children}
      {enabled ? <RecordingPill /> : null}
      {enabled ? <DiaryAutoGenerator /> : null}
    </RecorderContext.Provider>
  );
}
