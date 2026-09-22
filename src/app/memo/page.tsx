"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookOpen, FlaskConical, Mic, MessageSquarePlus, RotateCcw, Upload, UserRound } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatDuration, KIND_LABEL, STATUS_LABEL } from "@/components/memo/labels";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { db } from "@/lib/db";
import { runPipeline, type PipelineProgress } from "@/lib/memo/client/orchestrator";
import { cleanupExpired, latestProfile } from "@/lib/memo/client/repo";
import { placeLabel } from "@/lib/memo/place";
import { effectiveDecision } from "@/lib/memo/select";
import { clockIn, dayKeyIn, deviceTimeZone, shortDay } from "@/lib/memo/time";
import type { MemoSession } from "@/lib/memo/types";
import styles from "./memo.module.css";

const ACTIVE: MemoSession["status"][] = ["recorded", "uploading", "preparing", "transcribing", "judging"];

export default function MemoHomePage() {
  const [today, setToday] = useState("");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [progress, setProgress] = useState<Record<string, PipelineProgress>>({});
  const sessions = useLiveQuery(() => db.memoSessions.orderBy("startedAt").reverse().limit(30).toArray(), [], []);
  const todayMoments = useLiveQuery(() => (today ? db.moments.where("dayKey").equals(today).toArray() : []), [today], []);
  const diaries = useLiveQuery(() => db.diaryDays.orderBy("dayKey").reverse().limit(14).toArray(), [], []);
  const voiceprint = useLiveQuery(() => db.memoVoiceprint.get("me"), [], undefined);
  const resumed = useRef(false);

  useEffect(() => {
    const tz = deviceTimeZone();
    setTimeZone(tz);
    setToday(dayKeyIn(new Date().toISOString(), tz));
    void cleanupExpired().catch(() => undefined);
    void latestProfile().catch(() => undefined);
  }, []);

  const onProgress = (p: PipelineProgress) => setProgress((prev) => ({ ...prev, [p.sessionId]: p }));

  // 刷新页面后从当前状态继续（spec §4.10 orchestrator）
  useEffect(() => {
    if (resumed.current || !sessions.length) return;
    resumed.current = true;
    for (const s of sessions) if (ACTIVE.includes(s.status)) void runPipeline(s.id, { onProgress });
  }, [sessions]);

  const todaySessions = useMemo(
    () => sessions.filter((s) => today && (dayKeyIn(s.startedAt, s.timeZone) === today || ACTIVE.includes(s.status) || s.status === "failed" || s.status === "recording")),
    [sessions, today],
  );
  const kept = useMemo(() => todayMoments.filter((m) => effectiveDecision(m) === "keep").sort((a, b) => a.at.localeCompare(b.at)), [todayMoments]);

  async function retry(session: MemoSession) {
    if (session.error?.code === "ASR_SUBMIT_UNKNOWN") {
      if (!window.confirm("上次提交语音识别时连接中断，不确定是否已经提交。重新提交可能重复计费（约 0.013 元/分钟录音），继续吗？")) return;
      await runPipeline(session.id, { retry: true, forceResubmit: true, onProgress });
      return;
    }
    await runPipeline(session.id, { retry: true, onProgress });
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className={styles.top}>
          <div className="brand-lockup">
            <h1>遇见手记</h1>
            <span>MEMO</span>
          </div>
          <div className={styles.row}>
            <Link className={styles.button} href="/memo/me">
              <UserRound size={14} /> 它眼中的我
            </Link>
          </div>
        </header>
        <p className={styles.subtitle}>你拍下看到的，它记下你想到的。</p>

        {LOCAL_ONLY ? (
          <div className={styles.warning} style={{ marginTop: 16 }}>离线本地版不支持遇见手记：录音需要上传到服务器转文字。</div>
        ) : null}

        {/* 没认过声音就提示一次。可点可忽略，不挡住录音入口 */}
        {voiceprint === undefined && !LOCAL_ONLY ? (
          <Link className={styles.enrollHint} href="/memo/enroll">
            <UserRound size={15} />
            <span>
              <strong>先让我认识你的声音</strong>
              <small>录音里不止你一个人说话，认过之后我才知道哪几句是你说的</small>
            </span>
          </Link>
        ) : null}

        <nav className={styles.entries} aria-label="记录入口">
          <Link className={`${styles.entry} ${styles.entryPrimary}`} href="/memo/record">
            <Mic size={24} />
            开始记录
            <small>到了新地方就录</small>
          </Link>
          <Link className={styles.entry} href="/memo/import">
            <Upload size={22} />
            导入录音
            <small>语音备忘录的文件</small>
          </Link>
          <Link className={styles.entry} href="/memo/record?kind=backfill">
            <MessageSquarePlus size={22} />
            补一段
            <small>事后感想，自动挂回</small>
          </Link>
        </nav>

        <p className={styles.privacy}>
          录音会上传到遇见集服务器转成单声道，再交给阿里云百炼语音识别（识别用的临时文件由百炼在 48 小时内自动清除）。转写完成后，服务器和这台手机上的音频都会删除。逐字稿只存在这台手机，7 天后清理；手记里只保留你自己说的原话，别人说的只保留转述。
        </p>

        <h2 className={styles.sectionTitle}>今天的录音</h2>
        <section className={styles.card}>
          {todaySessions.length === 0 ? (
            <p className={`${styles.muted} ${styles.small}`}>今天还没有录音。</p>
          ) : (
            todaySessions.map((s) => {
              const p = progress[s.id];
              const running = ACTIVE.includes(s.status);
              return (
                <div key={s.id} className={styles.listItem}>
                  <div className={styles.between}>
                    <Link href={`/memo/session/${s.id}`} className={styles.back}>
                      {clockIn(s.startedAt, s.timeZone)} · {KIND_LABEL[s.kind]} · {formatDuration(s.durationSec)}
                    </Link>
                    <span className={`${styles.badge} ${s.status === "failed" ? styles.badgeWarn : s.status === "ready" ? styles.badgeOk : ""}`}>{STATUS_LABEL[s.status]}</span>
                  </div>
                  {running && p ? (
                    <>
                      <span className={`${styles.small} ${styles.muted}`}>{p.message}</span>
                      {p.total ? (
                        <div className={styles.progressTrack}>
                          <div className={styles.progressBar} style={{ width: `${Math.round(((p.done ?? 0) / p.total) * 100)}%` }} />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {s.status === "recording" ? (
                    <div className={styles.row}>
                      <span className={`${styles.small} ${styles.muted}`}>这段录音没有正常结束（页面被关掉或刷新）。</span>
                      <button className={styles.button} type="button" onClick={() => void runPipeline(s.id, { onProgress })}>
                        处理已录下的部分
                      </button>
                    </div>
                  ) : null}
                  {s.error ? (
                    <div className={styles.row}>
                      <span className={`${styles.small} ${s.error.code === "PARTIAL" ? styles.muted : ""}`} style={{ color: s.error.code === "PARTIAL" ? undefined : "var(--warning)" }}>
                        {s.error.message}
                      </span>
                      {s.status === "failed" && s.error.retryable ? (
                        <button className={styles.button} type="button" onClick={() => void retry(s)}>
                          <RotateCcw size={13} /> {s.error.code === "ASR_SUBMIT_UNKNOWN" ? "重新提交" : "重试"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>

        <div className={styles.between} style={{ marginTop: 22 }}>
          <h2 className={styles.sectionTitle} style={{ margin: 0 }}>今天到目前为止</h2>
          {today ? (
            <Link className={styles.button} href={`/memo/day/${today}`}>
              <BookOpen size={14} /> 今日手记
            </Link>
          ) : null}
        </div>
        <section className={styles.card} style={{ marginTop: 8 }}>
          {kept.length === 0 ? (
            <p className={`${styles.muted} ${styles.small}`}>还没有留下的片段。</p>
          ) : (
            kept.map((m) => (
              <div key={m.id} className={styles.listItem}>
                <span className={`${styles.small} ${styles.muted}`}>
                  {clockIn(m.at, timeZone)} · {placeLabel(m.place)}
                </span>
                <strong style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{m.trigger}</strong>
                <span className={`${styles.small} ${styles.muted}`}>{m.why}</span>
              </div>
            ))
          )}
        </section>

        {diaries.length ? (
          <>
            <h2 className={styles.sectionTitle}>最近的手记</h2>
            <section className={styles.card}>
              {diaries.map((d) => (
                <Link key={d.dayKey} className={styles.listItem} href={`/memo/day/${d.dayKey}`}>
                  <div className={styles.between}>
                    <strong style={{ fontFamily: "var(--serif)" }}>{d.title}</strong>
                    <span className={`${styles.small} ${styles.muted}`}>{shortDay(d.dayKey)}</span>
                  </div>
                  <span className={`${styles.small} ${styles.muted}`}>
                    {d.paragraphs.length} 段 · 折叠 {d.foldedMomentIds.length} 段{d.status === "partial" ? " · 部分失败" : ""}
                  </span>
                </Link>
              ))}
            </section>
          </>
        ) : null}

        <div className={styles.row} style={{ marginTop: 18 }}>
          <Link className={styles.button} href="/memo/lab">
            <FlaskConical size={14} /> 实验室
          </Link>
        </div>
      </div>
      <AppNav />
    </main>
  );
}
