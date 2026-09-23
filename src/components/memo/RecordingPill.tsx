"use client";

// 录音胶囊（工单 Gate 2.2）：录音中在所有页面顶部可见，点一下停止；
// 停止后显示处理进度和结果，几秒后收起。录音页自己有大按钮，那里不显示。
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useRecorder } from "./RecorderProvider";
import styles from "./RecordingPill.module.css";

const DONE_VISIBLE_MS = 4_000;

export function RecordingPill() {
  const { recording, jobs, stop, needsEnroll, dismissEnroll, clearError } = useRecorder();
  const pathname = usePathname();
  const [now, setNow] = useState(() => Date.now());

  const active = recording.phase === "recording" || recording.phase === "stopping" || recording.phase === "starting";
  const latest = jobs.at(-1);
  const showJob = !active && latest && (latest.status === "processing" || now - (latest.finishedAt ?? now) < DONE_VISIBLE_MS);

  useEffect(() => {
    if (!active && !showJob) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, showJob]);

  if (pathname.startsWith("/memo/record")) return null;

  if (active) {
    const elapsed = recording.startedAtMs ? Math.max(0, Math.floor((now - recording.startedAtMs) / 1000)) : 0;
    return (
      <div className={styles.wrap}>
        <button
          type="button"
          className={`${styles.pill} ${styles.recording}`}
          onClick={() => void stop()}
          disabled={recording.phase !== "recording"}
          aria-label={recording.phase === "recording" ? "正在录音，点一下停止" : "正在保存录音"}
        >
          <span className={styles.dot} aria-hidden />
          {recording.phase === "starting" ? "准备录音…" : recording.phase === "stopping" ? "正在保存…" : `录音中 ${clock(elapsed)} · 点此停止`}
        </button>
        {needsEnroll && recording.phase === "recording" ? (
          <div className={styles.hint}>
            <Link href="/memo/enroll">花 8 秒让它认识你的声音</Link>
            <button type="button" onClick={dismissEnroll} aria-label="不用了">
              ×
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (recording.error) {
    return (
      <div className={styles.wrap}>
        <button type="button" className={`${styles.pill} ${styles.error}`} role="alert" onClick={clearError} aria-label="关闭提示">
          {recording.error} ×
        </button>
      </div>
    );
  }

  if (showJob && latest) {
    return (
      <div className={styles.wrap}>
        {latest.status === "processing" ? (
          <div className={styles.pill} role="status">
            处理中 · {latest.message}
          </div>
        ) : latest.status === "done" ? (
          <Link className={`${styles.pill} ${styles.done}`} href={latest.dayKey ? `/memo/day/${latest.dayKey}` : `/memo/session/${latest.sessionId}`}>
            ✓ 已记下 · {latest.message}
          </Link>
        ) : (
          <Link className={`${styles.pill} ${styles.error}`} href={`/memo/session/${latest.sessionId}`}>
            处理失败 · 查看
          </Link>
        )}
      </div>
    );
  }
  return null;
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
