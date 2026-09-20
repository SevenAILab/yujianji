"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, FlaskConical } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { DECISION_LABEL, SPEAKER_LABEL } from "@/components/memo/labels";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { labCompare, type LabComparison, type LabRun } from "@/lib/memo/client/learn";
import { CATEGORY_LABELS } from "@/lib/memo/schema";
import { clockIn, dayKeyIn } from "@/lib/memo/time";
import type { Profile } from "@/lib/memo/types";
import styles from "../memo.module.css";

export default function LabPage() {
  const options = useLiveQuery(async () => {
    const [windows, sessions, utteranceIds] = await Promise.all([db.memoWindows.toArray(), db.memoSessions.toArray(), db.utterances.toCollection().primaryKeys()]);
    const alive = new Set(utteranceIds);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return windows
      .filter((w) => w.utteranceIds.some((id) => alive.has(id)) && byId.has(w.sessionId))
      .map((w) => ({ window: w, session: byId.get(w.sessionId)! }))
      .sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt) || a.window.index - b.window.index);
  }, [], []);
  const profiles = useLiveQuery(() => db.profiles.orderBy("version").toArray(), [], []);
  const [windowId, setWindowId] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LabComparison | null>(null);

  const selectedId = windowId || options[0]?.window.id || "";
  const selected = options.find((o) => o.window.id === selectedId);
  const beforeVersion = before ?? profiles.at(-2)?.version ?? profiles.at(-1)?.version ?? 1;
  const afterVersion = after ?? profiles.at(-1)?.version ?? 1;
  const utterances = useLiveQuery(async () => (selected ? (await db.utterances.bulkGet(selected.window.utteranceIds)).filter(Boolean) : []), [selectedId], []);
  const ruleDiff = useMemo(() => diffRules(profiles.find((p) => p.version === beforeVersion), profiles.find((p) => p.version === afterVersion)), [profiles, beforeVersion, afterVersion]);

  async function run() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await labCompare(selectedId, { before: beforeVersion, after: afterVersion }));
    } catch (cause) {
      setError(describeMemoError(cause));
    } finally {
      setBusy(false);
    }
  }

  const decisionOf = (run: LabRun, utteranceId: string) => run.result?.moments.find((m) => m.sourceUtteranceIds.includes(utteranceId))?.decision;

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/memo/me">
            <ChevronLeft size={16} /> 它眼中的我
          </Link>
        </div>
        <h1 className={styles.title}>实验室</h1>
        <p className={styles.subtitle}>同一段录音，用学习前和学习后的「它眼中的我」各判断一次，并排看哪里改判了。</p>

        <section className={styles.card} style={{ marginTop: 14 }}>
          {options.length === 0 ? (
            <p className={`${styles.small} ${styles.muted}`}>还没有可以对比的录音窗口（逐字稿 7 天后会清理）。</p>
          ) : (
            <div className={styles.stack} style={{ marginTop: 0 }}>
              <label className={styles.label}>
                录音窗口
                <select className={styles.select} value={selectedId} onChange={(e) => setWindowId(e.target.value)}>
                  {options.map(({ window: w, session: s }) => (
                    <option key={w.id} value={w.id}>
                      {dayKeyIn(s.startedAt, s.timeZone).slice(5)} {clockIn(s.startedAt, s.timeZone)} · 窗口 {w.index + 1}（我说了 {w.meChars} 字）
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.labGrid}>
                <label className={styles.label}>
                  学习前
                  <select className={styles.select} value={beforeVersion} onChange={(e) => setBefore(Number(e.target.value))}>
                    {profiles.map((p) => (
                      <option key={p.version} value={p.version}>
                        v{p.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.label}>
                  学习后
                  <select className={styles.select} value={afterVersion} onChange={(e) => setAfter(Number(e.target.value))}>
                    {profiles.map((p) => (
                      <option key={p.version} value={p.version}>
                        v{p.version}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {ruleDiff.length ? (
                <div className={styles.notice}>
                  {ruleDiff.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              ) : (
                <p className={`${styles.small} ${styles.muted}`}>两个版本的规则一样。先在手记里删掉两段同类内容，再点「让它学习」。</p>
              )}
              <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={busy || !selectedId} onClick={() => void run()}>
                <FlaskConical size={13} /> {busy ? "两个版本同时判断中…" : "各跑一次判断"}
              </button>
            </div>
          )}
        </section>
        {error ? <div className={styles.warning} style={{ marginTop: 10 }}>{error}</div> : null}

        {result ? (
          <>
            <h2 className={styles.sectionTitle}>逐句对比（改判的高亮）</h2>
            <section className={styles.card}>
              <div className={styles.labGrid} style={{ marginBottom: 6 }}>
                <span className={`${styles.small} ${styles.muted}`}>v{result.before.profileVersion}{result.before.error ? `：失败 ${result.before.error}` : ""}</span>
                <span className={`${styles.small} ${styles.muted}`}>v{result.after.profileVersion}{result.after.error ? `：失败 ${result.after.error}` : ""}</span>
              </div>
              {utterances.map((u) => {
                if (!u) return null;
                const changed = result.changedUtteranceIds.includes(u.id);
                const a = decisionOf(result.before, u.id);
                const b = decisionOf(result.after, u.id);
                return (
                  <div key={u.id} className={`${styles.listItem} ${changed ? styles.changed : ""}`}>
                    <span className={styles.small}>
                      <span className={`${styles.speakerTag} ${styles[u.speaker]}`}>{SPEAKER_LABEL[u.speaker]}</span> {u.text}
                    </span>
                    <div className={styles.labGrid}>
                      <span>{a ? <span className={`${styles.badge} ${styles[a]}`}>{DECISION_LABEL[a]}</span> : <span className={`${styles.small} ${styles.muted}`}>未交</span>}</span>
                      <span>{b ? <span className={`${styles.badge} ${styles[b]}`}>{DECISION_LABEL[b]}</span> : <span className={`${styles.small} ${styles.muted}`}>未交</span>}</span>
                    </div>
                  </div>
                );
              })}
            </section>

            <div className={styles.labGrid} style={{ marginTop: 12 }}>
              {[result.before, result.after].map((run) => (
                <section key={run.profileVersion + (run === result.before ? "a" : "b")} className={styles.card}>
                  <strong className={styles.small}>v{run.profileVersion} 的片段</strong>
                  {run.result?.moments.map((m, i) => (
                    <div key={i} className={styles.listItem}>
                      <span className={styles.row}>
                        <span className={`${styles.badge} ${styles[m.decision]}`}>{DECISION_LABEL[m.decision]}</span>
                        <span className={`${styles.small} ${styles.muted}`}>{CATEGORY_LABELS[m.category as keyof typeof CATEGORY_LABELS] ?? m.category}</span>
                      </span>
                      <span className={styles.small}>{m.trigger}</span>
                      <span className={`${styles.small} ${styles.muted}`}>{m.why}</span>
                    </div>
                  ))}
                  {run.result ? (
                    <Link className={styles.button} href={`/memo/trace/${encodeURIComponent(run.result.trace.runId)}`}>
                      过程
                    </Link>
                  ) : null}
                </section>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <AppNav />
    </main>
  );
}

function diffRules(before?: Profile, after?: Profile): string[] {
  if (!before || !after || before.version === after.version) return [];
  const lines: string[] = [];
  const old = new Map(before.rules.map((r) => [r.id, r]));
  for (const rule of after.rules) {
    const prev = old.get(rule.id);
    if (!prev) lines.push(`新增：${rule.text}`);
    else if (prev.text !== rule.text) lines.push(`修改：${prev.text} → ${rule.text}`);
    else if (prev.active && !rule.active) lines.push(`停用：${rule.text}`);
    else if (!prev.active && rule.active) lines.push(`启用：${rule.text}`);
  }
  return lines;
}
