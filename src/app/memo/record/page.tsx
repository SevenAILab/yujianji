"use client";

// 录音页：和首页、胶囊共用同一个全局录音器（RecorderProvider），这里只是它的大号界面。
// 录完不再跳手帐页——手帐一天结束时统一生成，想现在看就点「现在就生成」。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChevronLeft, MapPin } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatDuration } from "@/components/memo/labels";
import { useRecorder, type RecorderKind } from "@/components/memo/RecorderProvider";
import { describeMemoError } from "@/lib/memo/client/api";
import { generateDiary } from "@/lib/memo/client/orchestrator";
import { dayKeyIn, deviceTimeZone } from "@/lib/memo/time";
import styles from "../memo.module.css";

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
  const kind: RecorderKind = params.get("kind") === "backfill" ? "backfill" : "in_app";
  const { supported, recording, jobs, start, stop } = useRecorder();
  const [now, setNow] = useState(() => Date.now());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  // 这一页上录完的那段：停止后在全局里处理，这里跟着显示进度
  const [lastSession, setLastSession] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (recording.sessionId) setLastSession(recording.sessionId);
  }, [recording.sessionId]);
  const job = jobs.find((j) => j.sessionId === lastSession);

  const active = recording.phase === "recording" || recording.phase === "stopping";
  // 别处（首页）已经在录另一种类型：这里显示同一个录音，不另起一个
  const otherKind = active && recording.kind !== kind;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsed = active && recording.startedAtMs ? Math.max(0, Math.floor((now - recording.startedAtMs) / 1000)) : 0;

  async function generateToday() {
    setGenerating(true);
    setError("");
    const today = job?.dayKey ?? dayKeyIn(new Date().toISOString(), deviceTimeZone());
    try {
      await generateDiary(today);
      router.push(`/memo/day/${today}`);
    } catch (cause) {
      setError(describeMemoError(cause));
      setGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/">
            <ChevronLeft size={16} /> 首页
          </Link>
          {active ? (
            <span className={styles.row}>
              <span className={styles.recDot} aria-hidden /> <strong style={{ color: "#c0392b", fontSize: 13 }}>正在录音</strong>
            </span>
          ) : null}
        </div>
        <h1 className={styles.title}>{kind === "backfill" ? "补一段" : "开始记录"}</h1>
        <p className={styles.subtitle}>
          {kind === "backfill" ? "聊起哪天、哪个地方的事，直接说。它会自己翻记忆，挂回那天那个地方。" : "到了没去过的地方，边逛边聊。它只留下你被新鲜的人、事、景触动的那几句。"}
        </p>

        {!supported.ok ? <div className={styles.warning} style={{ marginTop: 14 }}>{supported.reason}</div> : null}

        <section className={`${styles.card} ${styles.recordStage}`}>
          {active ? (
            <>
              <div className={styles.timer}>{formatClock(elapsed)}</div>
              <div className={`${styles.row} ${styles.small} ${styles.muted}`} style={{ justifyContent: "center" }}>
                <MapPin size={13} />
                {recording.place === undefined ? "正在取定位…" : recording.place ?? "定位不可用"}
                <span>· 已存 {recording.chunks} 块</span>
              </div>
              {otherKind ? <p className={`${styles.small} ${styles.muted}`}>这是在别的页面开始的那段录音。</p> : null}
              <button className={`${styles.recordButton} ${styles.recordButtonStop}`} type="button" onClick={() => void stop()} disabled={recording.phase === "stopping"}>
                {recording.phase === "stopping" ? "保存中" : "停止"}
              </button>
            </>
          ) : job?.status === "processing" ? (
            <>
              <strong>{job.message}</strong>
              <p className={`${styles.small} ${styles.muted}`}>上传 → 转文字 → Agent 判断。可以离开这个页面，处理会在后台继续。</p>
              <Link className={styles.button} href={`/memo/session/${job.sessionId}`}>
                看处理过程
              </Link>
            </>
          ) : job?.status === "done" ? (
            <>
              <strong>已记下</strong>
              <p className={`${styles.small} ${styles.muted}`}>{job.message}。一天结束时会和当天的照片一起写成手帐。</p>
              <div className={styles.row} style={{ justifyContent: "center" }}>
                <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={() => void generateToday()} disabled={generating}>
                  {generating ? "正在整理…" : "现在就生成"}
                </button>
                <Link className={styles.button} href={`/memo/session/${job.sessionId}`}>
                  看这段
                </Link>
              </div>
            </>
          ) : (
            <>
              {job?.status === "error" ? (
                <div className={styles.warning}>
                  上一段处理失败：{job.message} <Link href={`/memo/session/${job.sessionId}`}>查看</Link>
                </div>
              ) : null}
              <button className={styles.recordButton} type="button" onClick={() => void start(kind)} disabled={!supported.ok || recording.phase === "starting"}>
                {recording.phase === "starting" ? "准备中" : "开始"}
              </button>
              <p className={`${styles.small} ${styles.muted}`}>先跟身边的人打个招呼。录音时每个页面顶部都会显示录音标识。</p>
            </>
          )}
        </section>

        {active && recording.interruptions ? (
          <div className={styles.warning} style={{ marginTop: 12 }}>
            刚才录音可能中断了（切到后台或锁屏 {recording.interruptions} 次）。已经录下的部分不会丢。
          </div>
        ) : null}
        {active && recording.wakeLock === false ? <div className={styles.notice} style={{ marginTop: 12 }}>这个浏览器不能保持屏幕常亮，请手动保持亮屏。</div> : null}
        {recording.error ? <div className={styles.warning} style={{ marginTop: 12 }}>{recording.error}</div> : null}
        {error ? <div className={styles.warning} style={{ marginTop: 12 }}>{error}</div> : null}

        <div className={styles.notice} style={{ marginTop: 14 }}>
          录音时可以切到别的页面、回首页拍照，录音不会停。锁屏或切到别的 App 可能会被系统打断，已录下的部分不会丢。
          {elapsed > 0 && active ? ` 已录 ${formatDuration(elapsed)}。` : ""}
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
