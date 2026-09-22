"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, RotateCcw, Trash2 } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { DECISION_LABEL, formatDuration, formatYuan, KIND_LABEL, SPEAKER_LABEL, STATUS_LABEL } from "@/components/memo/labels";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { correctSpeakers, rejudgeWindow, runPipeline, STAGE_BUDGET_MS, type PipelineProgress } from "@/lib/memo/client/orchestrator";
import { deleteSession } from "@/lib/memo/client/repo";
import { placeLabel } from "@/lib/memo/place";
import { CATEGORY_LABELS } from "@/lib/memo/schema";
import { clockIn, dayKeyIn } from "@/lib/memo/time";
import type { MemoSession } from "@/lib/memo/types";
import styles from "../../memo.module.css";

/** 每种定"我"的方式对应一句人话。少了哪一种，UI 就会说出不符合实际的解释。 */
const ME_SOURCE_TEXT: Record<string, string> = {
  enrolled: "认出了你注册过的声音。",
  opening: "录音一开始说话的是你。",
  loudness: "按音量判断：手机在你身上，最响的通常是你。",
  loudness_weak: "几位说话人音量接近，先按最响的当你——认错了就改。",
  single_speaker: "只有一位说话人，默认是你。",
  user: "你手动指定过。",
  unavailable: "这次算不出响度。",
};

const STAGE_LABEL = { upload: "上传", prepare: "转码+临时存储", transcribe: "转文字", triage: "粗筛", judge: "判断", write: "写作" } as const;

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const session = useLiveQuery(async () => (await db.memoSessions.get(id)) ?? null, [id]);
  const utterances = useLiveQuery(() => db.utterances.where("sessionId").equals(id).sortBy("index"), [id], []);
  const windows = useLiveQuery(() => db.memoWindows.where("sessionId").equals(id).sortBy("index"), [id], []);
  const moments = useLiveQuery(() => db.moments.where("sessionId").equals(id).toArray(), [id], []);
  const traces = useLiveQuery(() => db.agentTraces.where("sessionId").equals(id).toArray(), [id], []);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [meKeys, setMeKeys] = useState<string[] | null>(null);

  const byUtterance = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances]);
  const cost = traces.reduce((sum, t) => sum + t.costYuan, 0);
  const estimated = traces.some((t) => t.costEstimated);
  const days = [...new Set(moments.filter((m) => m.decision !== "drop").map((m) => m.dayKey))].sort();

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(describeMemoError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) return <Shell>加载中…</Shell>;
  if (session === null) return <Shell>找不到这段录音，可能已经删除。</Shell>;

  const selectedMe = meKeys ?? (session.speakers ?? []).filter((s) => s.role === "me").map((s) => s.key);
  const retry = (s: MemoSession) =>
    act(async () => {
      if (s.error?.code === "ASR_SUBMIT_UNKNOWN") {
        if (!window.confirm("上次提交语音识别结果不明，重新提交可能重复计费（约 0.013 元/分钟录音），继续吗？")) return;
        await runPipeline(s.id, { retry: true, forceResubmit: true, onProgress: setProgress });
      } else {
        await runPipeline(s.id, { retry: true, onProgress: setProgress });
      }
    });

  // 说话人选择器：认准了的时候收在「认错了？」里，拿不准时直接展开
  const speakerPicker = (
    <>
      {(session?.speakers ?? []).map((s) => {
        const sample = utterances.find((u) => u.speakerKey === s.key)?.text ?? "";
        return (
          <label key={s.key} className={styles.listItem} style={{ gridTemplateColumns: "auto 1fr", alignItems: "start", columnGap: 10 }}>
            <input
              type="checkbox"
              checked={selectedMe.includes(s.key)}
              onChange={(e) => setMeKeys(e.target.checked ? [...selectedMe, s.key] : selectedMe.filter((k) => k !== s.key))}
            />
            <span className={styles.small}>
              <span className={`${styles.badge} ${s.role === "me" ? styles.keep : s.role === "uncertain" ? styles.badgeWarn : styles.badgeMuted}`}>{SPEAKER_LABEL[s.role]}</span> 说话人 {s.key} · {s.meanDb === null ? "响度未知" : `${s.meanDb} dB`} · 说了 {Math.round(s.talkMs / 1000)} 秒
              <br />
              <span className={styles.muted}>「{sample.slice(0, 32)}{sample.length > 32 ? "…" : ""}」</span>
            </span>
          </label>
        );
      })}
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        style={{ marginTop: 8 }}
        disabled={busy || !selectedMe.length || !utterances.length}
        onClick={() => void act(() => correctSpeakers(id, selectedMe, { onProgress: setProgress }))}
      >
        按勾选的"我"重新判断这场
      </button>
    </>
  );

  return (
    <Shell>
      <h1 className={styles.title}>
        {KIND_LABEL[session.kind]} · {dayKeyIn(session.startedAt, session.timeZone).slice(5)} {clockIn(session.startedAt, session.timeZone)}
      </h1>
      <p className={styles.subtitle}>
        {placeLabel(session.place)} · {formatDuration(session.durationSec)} · 时间来源：{session.startedAtSource === "recorder" ? "录音时钟" : session.startedAtSource === "file_metadata" ? "文件里的录制时间" : "你确认的时间"} · {session.timeZone}
      </p>

      <section className={styles.card} style={{ marginTop: 14 }}>
        <div className={styles.between}>
          <span className={`${styles.badge} ${session.status === "failed" ? styles.badgeWarn : session.status === "ready" ? styles.badgeOk : ""}`}>{STATUS_LABEL[session.status]}</span>
          <span className={`${styles.small} ${styles.muted}`}>
            费用 {formatYuan(cost)}
            {estimated ? "（含估算）" : ""}
          </span>
        </div>
        {progress && busy ? <p className={`${styles.small} ${styles.muted}`}>{progress.message}</p> : null}
        {session.error ? (
          <div className={styles.row} style={{ marginTop: 8 }}>
            <span className={styles.small} style={{ color: "var(--warning)" }}>
              {session.error.message}（{session.error.code}）
            </span>
            {session.status === "failed" && session.error.retryable ? (
              <button type="button" className={styles.button} disabled={busy} onClick={() => void retry(session)}>
                <RotateCcw size={13} /> {session.error.code === "ASR_SUBMIT_UNKNOWN" ? "重新提交（可能重复计费）" : "重试"}
              </button>
            ) : null}
          </div>
        ) : null}
        {session.interruptions?.length ? <p className={`${styles.small} ${styles.muted}`}>录音中切到后台或锁屏 {session.interruptions.length} 次，中断期间的声音可能没录上。</p> : null}
        <div className={styles.row} style={{ marginTop: 10 }}>
          {days.map((d) => (
            <Link key={d} className={styles.button} href={`/memo/day/${d}`}>
              看 {d.slice(5)} 的手记
            </Link>
          ))}
          {traces.some((t) => t.runId === `pipe_${id}`) ? (
            <Link className={styles.button} href={`/memo/trace/${encodeURIComponent(`pipe_${id}`)}`}>
              录音处理过程
            </Link>
          ) : null}
        </div>
      </section>

      {session.timings?.length ? (
        <>
          <h2 className={styles.sectionTitle}>各阶段耗时（预算）</h2>
          <section className={styles.card}>
            {session.timings.map((t) => (
              <div key={t.stage} className={styles.between} style={{ padding: "4px 0" }}>
                <span className={styles.small}>{STAGE_LABEL[t.stage]}</span>
                <span className={`${styles.small} ${t.overBudget ? styles.overBudget : styles.muted}`}>
                  {((t.ms ?? 0) / 1000).toFixed(1)} 秒 / {STAGE_BUDGET_MS[t.stage] / 1000} 秒{t.stage === "judge" ? "（每段）" : ""}
                </span>
              </div>
            ))}
          </section>
        </>
      ) : null}

      {session.speakers?.length ? (
        <>
          <h2 className={styles.sectionTitle}>谁是"我"</h2>
          <section className={styles.card}>
            {session.meUncertain ? (
              <div className={styles.warning} style={{ marginBottom: 10 }}>
                {session.meSource === "unavailable" ? "这次算不出响度，" : "几位说话人的音量差不多，"}拿不准哪位是你。勾选你自己，再重新判断这场。
              </div>
            ) : (
              <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 0 }}>{ME_SOURCE_TEXT[session.meSource ?? "loudness"]}</p>
            )}
            {/* 认准了就不铺开：说话人列表会把每个人说的原话摊出来，看着尴尬。要改再展开 */}
            {!session.meUncertain ? (
              <details className={styles.entryMore} style={{ marginTop: 6 }}>
                <summary className={`${styles.small} ${styles.muted}`} style={{ cursor: "pointer" }}>认错了？点这里改</summary>
                <div style={{ marginTop: 10 }}>{speakerPicker}</div>
              </details>
            ) : (
              speakerPicker
            )}
          </section>
        </>
      ) : null}

      <h2 className={styles.sectionTitle}>逐字稿与判断（按窗口）</h2>
      {windows.length && !utterances.length ? <div className={styles.notice}>逐字稿已超过 7 天自动清理，只剩下留下的片段。</div> : null}
      <div className={styles.stack} style={{ marginTop: 0 }}>
        {windows.map((w) => {
          const inWindow = moments.filter((m) => m.windowId === w.id);
          return (
            <section key={w.id} className={styles.card}>
              <div className={styles.between}>
                <strong className={styles.small}>
                  窗口 {w.index + 1} · {mmss(w.beginMs)}–{mmss(w.endMs)}
                </strong>
                <span className={styles.row}>
                  {w.triage ? (
                    <Link className={`${styles.badge} ${w.triage.action === "skip" ? styles.badgeMuted : ""}`} href={w.triage.runId.endsWith("_local") || w.triage.runId.endsWith("_failed") ? "#" : `/memo/trace/${encodeURIComponent(w.triage.runId)}`}>
                      粗筛 {w.triage.action === "skip" ? "跳过" : "细看"}
                    </Link>
                  ) : null}
                  {w.judge ? (
                    <Link className={`${styles.badge} ${w.judge.status === "failed" ? styles.badgeWarn : styles.badgeOk}`} href={`/memo/trace/${encodeURIComponent(w.judge.runId)}`}>
                      判断 {w.judge.status === "done" ? "完成" : "失败"}
                    </Link>
                  ) : null}
                </span>
              </div>
              {w.triage ? <p className={`${styles.small} ${styles.muted}`} style={{ margin: "6px 0" }}>粗筛：{w.triage.reason}</p> : null}
              {w.judge?.status === "failed" ? (
                <button type="button" className={styles.button} disabled={busy} onClick={() => void act(() => rejudgeWindow(w.id, { onProgress: setProgress }))}>
                  <RotateCcw size={13} /> 重跑这段（{w.judge.error}）
                </button>
              ) : null}
              {w.utteranceIds.map((uid) => {
                const u = byUtterance.get(uid);
                if (!u) return null;
                return (
                  <div key={uid} className={styles.utterance}>
                    <span className={`${styles.speakerTag} ${styles[u.speaker]}`}>{SPEAKER_LABEL[u.speaker]}</span>
                    <span>
                      <span className={styles.stepMeta}>{mmss(u.beginMs)} </span>
                      {u.text}
                    </span>
                  </div>
                );
              })}
              {inWindow.length ? (
                <div style={{ marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                  {inWindow.map((m) => (
                    <div key={m.id} style={{ padding: "6px 0" }}>
                      <div className={styles.row}>
                        <span className={`${styles.badge} ${styles[m.decision]}`}>{DECISION_LABEL[m.decision]}</span>
                        <span className={styles.badge}>{CATEGORY_LABELS[m.category]}</span>
                        {m.speakerUncertain ? <span className={`${styles.badge} ${styles.badgeWarn}`}>说话人拿不准</span> : null}
                        {m.user.decision ? <span className={`${styles.badge} ${styles.badgeMuted}`}>你{m.user.decision === "drop" ? "删掉了" : "捞回了"}</span> : null}
                        <span className={`${styles.small} ${styles.muted}`}>s={m.salience.toFixed(2)}</span>
                      </div>
                      <p className={styles.small} style={{ margin: "4px 0 0" }}>
                        <strong>{m.trigger}</strong> · {m.why}
                      </p>
                      {m.guardNotes?.length ? <p className={`${styles.small} ${styles.muted}`} style={{ margin: 0 }}>守卫：{m.guardNotes.join("、")}</p> : null}
                      {m.facts?.map((f) => (
                        <p key={f.entity} className={styles.fact}>
                          AI 补充，未经核实：{f.fact}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {error ? <div className={styles.warning} style={{ marginTop: 12 }}>{error}</div> : null}

      <button
        type="button"
        className={`${styles.button} ${styles.buttonDanger}`}
        style={{ marginTop: 20 }}
        onClick={() => {
          if (!window.confirm("删除这段录音的逐字稿和所有片段？手记里对应的段落也会消失。")) return;
          void deleteSession(id).then(() => router.push("/memo"));
        }}
      >
        <Trash2 size={13} /> 删除这段录音的数据
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/memo">
            <ChevronLeft size={16} /> 遇见手记
          </Link>
        </div>
        {children}
      </div>
      <AppNav />
    </main>
  );
}
