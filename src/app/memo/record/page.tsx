"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ChevronLeft, MapPin } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatDuration } from "@/components/memo/labels";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { createSession, finalizeAudio, runPipeline, type PipelineProgress } from "@/lib/memo/client/orchestrator";
import { MemoRecorder, recordingSupported } from "@/lib/memo/client/recorder";
import { deleteSession, patchSession } from "@/lib/memo/client/repo";
import type { MemoSession } from "@/lib/memo/types";
import styles from "../memo.module.css";

type Phase = "idle" | "starting" | "recording" | "stopping" | "processing" | "error";

export default function RecordPage() {
  return (
    <Suspense fallback={null}>
      <RecordInner />
    </Suspense>
  );
}

function RecordInner() {
  const params = useSearchParams();
  const router = useRouter();
  const kind = params.get("kind") === "backfill" ? "backfill" : "in_app";
  const [phase, setPhase] = useState<Phase>("idle");
  const [support, setSupport] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [elapsed, setElapsed] = useState(0);
  const [chunks, setChunks] = useState(0);
  const [place, setPlace] = useState<string | null | undefined>(undefined);
  const [interruptions, setInterruptions] = useState<string[]>([]);
  const [wakeLock, setWakeLock] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const recorder = useRef<MemoRecorder | null>(null);
  const session = useRef<MemoSession | null>(null);
  const startedAtMs = useRef(0);

  useEffect(() => setSupport(recordingSupported()), []);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtMs.current) / 1000)), 1000);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", warn);
    };
  }, [phase]);

  useEffect(() => () => recorder.current?.release(), []);

  async function start() {
    setError("");
    setPhase("starting");
    try {
      const created = await createSession({ kind, startedAt: new Date().toISOString(), durationSec: 0, startedAtSource: "recorder", status: "recording" });
      session.current = created;
      const rec = new MemoRecorder(created.id, {
        onChunk: (index) => setChunks(index + 1),
        onInterruption: (at) => setInterruptions((list) => [...list, at]),
        onLocation: setPlace,
        onWakeLock: setWakeLock,
      });
      recorder.current = rec;
      await rec.start();
      startedAtMs.current = Date.now();
      await patchSession(created.id, { startedAt: rec.startedAt });
      setPhase("recording");
    } catch (cause) {
      if (session.current) await deleteSession(session.current.id).catch(() => undefined);
      session.current = null;
      setError(cause instanceof Error && cause.name === "NotAllowedError" ? "没有麦克风权限。请在浏览器设置里允许，或者改用「导入录音」。" : describeMemoError(cause));
      setPhase("error");
    }
  }

  async function stop() {
    const rec = recorder.current;
    const current = session.current;
    if (!rec || !current) return;
    setPhase("stopping");
    try {
      const out = await rec.stop();
      if (out.blob.size === 0) throw new Error("没有录到声音");
      const durationSec = Math.max(1, Math.round((new Date(out.endedAt).getTime() - new Date(out.startedAt).getTime()) / 1000));
      await finalizeAudio(current.id, out.blob, out.mimeType, {
        endedAt: out.endedAt,
        durationSec,
        interruptions: out.interruptions,
        ...(place ? { place: { name: place, source: "gps" as const, confidence: "medium" as const } } : {}),
      });
      setPhase("processing");
      const final = await runPipeline(current.id, { onProgress: setProgress });
      if (final.status === "ready") {
        const moments = await db.moments.where("sessionId").equals(current.id).toArray();
        const day = moments.find((m) => m.decision !== "drop")?.dayKey;
        router.push(day ? `/memo/day/${day}` : `/memo/session/${current.id}`);
      } else {
        router.push(`/memo/session/${current.id}`);
      }
    } catch (cause) {
      setError(describeMemoError(cause));
      setPhase("error");
    }
  }

  const recording = phase === "recording" || phase === "stopping";

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/memo">
            <ChevronLeft size={16} /> 遇见手记
          </Link>
          {recording ? (
            <span className={styles.row}>
              <span className={styles.recDot} aria-hidden /> <strong style={{ color: "#c0392b", fontSize: 13 }}>正在录音</strong>
            </span>
          ) : null}
        </div>
        <h1 className={styles.title}>{kind === "backfill" ? "补一段" : "开始记录"}</h1>
        <p className={styles.subtitle}>
          {kind === "backfill" ? "聊起哪天、哪个地方的事，直接说。它会自己翻记忆，挂回那天那个地方。" : "到了没去过的地方，边逛边聊。它只留下你被新鲜的人、事、景触动的那几句。"}
        </p>

        {!support.ok ? <div className={styles.warning} style={{ marginTop: 14 }}>{support.reason}</div> : null}

        <section className={`${styles.card} ${styles.recordStage}`}>
          {recording ? (
            <>
              <div className={styles.timer}>{formatClock(elapsed)}</div>
              <div className={`${styles.row} ${styles.small} ${styles.muted}`} style={{ justifyContent: "center" }}>
                <MapPin size={13} />
                {place === undefined ? "正在取定位…" : place ?? "定位不可用"}
                <span>· 已存 {chunks} 块</span>
              </div>
              <button className={`${styles.recordButton} ${styles.recordButtonStop}`} type="button" onClick={() => void stop()} disabled={phase === "stopping"}>
                {phase === "stopping" ? "保存中" : "停止"}
              </button>
            </>
          ) : phase === "processing" ? (
            <>
              <strong>{progress?.message ?? "开始处理"}</strong>
              {progress?.total ? (
                <div className={styles.progressTrack} style={{ width: "100%" }}>
                  <div className={styles.progressBar} style={{ width: `${Math.round(((progress.done ?? 0) / progress.total) * 100)}%` }} />
                </div>
              ) : null}
              <p className={`${styles.small} ${styles.muted}`}>上传 → 转文字 → Agent 判断 → 写手记。可以离开这个页面，回到「遇见手记」首页会接着处理。</p>
              {session.current ? (
                <Link className={styles.button} href={`/memo/session/${session.current.id}`}>
                  看处理过程
                </Link>
              ) : null}
            </>
          ) : (
            <>
              <button className={styles.recordButton} type="button" onClick={() => void start()} disabled={!support.ok || phase === "starting"}>
                {phase === "starting" ? "准备中" : "开始"}
              </button>
              <p className={`${styles.small} ${styles.muted}`}>先跟身边的人打个招呼。录音时界面会一直显示录音标识。</p>
            </>
          )}
        </section>

        {recording && interruptions.length ? (
          <div className={styles.warning} style={{ marginTop: 12 }}>
            刚才录音可能中断了（切到后台或锁屏 {interruptions.length} 次）。已经录下的部分不会丢。
          </div>
        ) : null}
        {recording && wakeLock === false ? <div className={styles.notice} style={{ marginTop: 12 }}>这个浏览器不能保持屏幕常亮，请手动保持亮屏。</div> : null}
        {error ? <div className={styles.warning} style={{ marginTop: 12 }}>{error}</div> : null}

        <div className={styles.notice} style={{ marginTop: 14 }}>
          录音时不要锁屏或切到别的 App。要边拍照边录，请用 iPhone 自带的「语音备忘录」录，回来用「导入录音」。
          {elapsed > 0 && recording ? ` 已录 ${formatDuration(elapsed)}。` : ""}
        </div>
      </div>
      <AppNav />
    </main>
  );
}

function formatClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
