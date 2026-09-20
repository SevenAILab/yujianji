"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Lock, Sparkles } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { ORIGIN_LABEL, RULE_KIND_LABEL } from "@/components/memo/labels";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { runReflect, saveUserRule, setRuleActive, type ReflectOutcome } from "@/lib/memo/client/learn";
import { latestProfile } from "@/lib/memo/client/repo";
import { FEEDBACK_EFFECTS } from "@/lib/memo/feedback";
import type { ProfileRule } from "@/lib/memo/types";
import styles from "../memo.module.css";

export default function MemoMePage() {
  const profiles = useLiveQuery(() => db.profiles.orderBy("version").reverse().toArray(), [], []);
  const events = useLiveQuery(() => db.feedbackEvents.toArray(), [], []);
  const profile = profiles[0];
  const evidenceIds = useMemo(() => [...new Set((profile?.rules ?? []).flatMap((r) => r.evidenceMomentIds))], [profile]);
  const evidence = useLiveQuery(async () => new Map((await db.moments.bulkGet(evidenceIds)).filter(Boolean).map((m) => [m!.id, m!])), [evidenceIds.join(",")], new Map());
  const [editing, setEditing] = useState<{ id?: string; kind: ProfileRule["kind"]; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReflectOutcome | null>(null);

  useEffect(() => {
    void latestProfile();
  }, []);

  const unconsumed = events.filter((e) => e.consumedByVersion === undefined);

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

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/memo">
            <ChevronLeft size={16} /> 遇见手记
          </Link>
          <Link className={styles.button} href="/memo/lab">
            实验室
          </Link>
        </div>
        <h1 className={styles.title}>它眼中的我</h1>
        <p className={styles.subtitle}>它不每天问你问题，只看你删掉、捞回、复制、改写了什么。每条规则都写明从哪学来，你能改、能停用。</p>

        <section className={styles.card} style={{ marginTop: 14 }}>
          <div className={styles.between}>
            <span className={styles.small}>
              当前版本 v{profile?.version ?? 1} · 待学习的操作 {unconsumed.length} 次
            </span>
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={busy || !unconsumed.length} onClick={() => void act(async () => setResult(await runReflect()))}>
              <Sparkles size={13} /> 让它学习
            </button>
          </div>
          {profile?.summary ? <p className={`${styles.small} ${styles.muted}`}>{profile.summary}</p> : null}
          {result ? (
            <div className={result.changed ? styles.notice : styles.warning} style={{ marginTop: 8 }}>
              {result.changed ? `更新到 v${result.profile.version}：${result.summary}` : `这次没改规则：${result.summary}`}
              {result.rejected.length ? (
                <div className={styles.small} style={{ marginTop: 6 }}>
                  代码拦下了 {result.rejected.length} 个操作：{result.rejected.map((r) => r.reason).join("；")}
                </div>
              ) : null}
              <div style={{ marginTop: 6 }}>
                <Link href={`/memo/trace/${encodeURIComponent(result.runId)}`}>看反思过程</Link>
              </div>
            </div>
          ) : null}
        </section>

        {(["drop", "keep", "style"] as const).map((kind) => (
          <div key={kind}>
            <h2 className={styles.sectionTitle}>{RULE_KIND_LABEL[kind]}</h2>
            <section className={styles.card}>
              {(profile?.rules ?? [])
                .filter((r) => r.kind === kind)
                .sort((a, b) => ["user", "learned", "seed"].indexOf(a.origin) - ["user", "learned", "seed"].indexOf(b.origin))
                .map((rule) => (
                  <div key={rule.id} className={styles.listItem} style={{ opacity: rule.active ? 1 : 0.5 }}>
                    {editing?.id === rule.id ? (
                      <RuleEditor value={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={() => void act(async () => { await saveUserRule(editing); setEditing(null); })} busy={busy} />
                    ) : (
                      <>
                        <span style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{rule.text}</span>
                        <div className={styles.row}>
                          <span className={`${styles.badge} ${rule.origin === "user" ? styles.keep : rule.origin === "learned" ? styles.fold : styles.badgeMuted}`}>{ORIGIN_LABEL[rule.origin]}</span>
                          {rule.locked ? (
                            <span className={`${styles.badge} ${styles.badgeMuted}`}>
                              <Lock size={11} /> 底线，学不走
                            </span>
                          ) : null}
                          {!rule.active ? <span className={`${styles.badge} ${styles.badgeWarn}`}>已停用</span> : null}
                          {rule.evidenceMomentIds.length ? (
                            <span className={`${styles.small} ${styles.muted}`}>
                              来自：
                              {rule.evidenceMomentIds.slice(0, 3).map((id, i) => {
                                const m = evidence.get(id);
                                return m ? (
                                  <Link key={id} href={`/memo/day/${m.dayKey}`} style={{ marginLeft: 4 }}>
                                    {m.dayKey.slice(5)} 的「{m.trigger.slice(0, 8)}」
                                  </Link>
                                ) : (
                                  <span key={id} style={{ marginLeft: 4 }}>片段{i + 1}（已删除）</span>
                                );
                              })}
                            </span>
                          ) : null}
                        </div>
                        {!rule.locked ? (
                          <div className={styles.row}>
                            <button type="button" className={`${styles.button} ${styles.buttonGhost}`} onClick={() => setEditing({ id: rule.id, kind: rule.kind, text: rule.text })}>
                              改
                            </button>
                            <button type="button" className={`${styles.button} ${styles.buttonGhost}`} disabled={busy} onClick={() => void act(() => setRuleActive(rule.id, !rule.active))}>
                              {rule.active ? "停用" : "启用"}
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ))}
            </section>
          </div>
        ))}

        <h2 className={styles.sectionTitle}>自己写一条</h2>
        <section className={styles.card}>
          {editing && !editing.id ? (
            <RuleEditor value={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={() => void act(async () => { await saveUserRule(editing); setEditing(null); })} busy={busy} />
          ) : (
            <button type="button" className={styles.button} onClick={() => setEditing({ kind: "drop", text: "" })}>
              新增规则（以你写的为准，优先级最高）
            </button>
          )}
        </section>
        {error ? <div className={styles.warning} style={{ marginTop: 10 }}>{error}</div> : null}

        <h2 className={styles.sectionTitle}>你的操作，它怎么理解</h2>
        <section className={styles.card}>
          {Object.values(FEEDBACK_EFFECTS).map((effect) => (
            <div key={effect.label} className={styles.listItem}>
              <strong className={styles.small}>{effect.label}</strong>
              <span className={`${styles.small} ${styles.muted}`}>当前手记：{effect.currentDiary}</span>
              <span className={`${styles.small} ${styles.muted}`}>下次写作：{effect.nextWrite}</span>
              <span className={`${styles.small} ${styles.muted}`}>它眼中的我：{effect.profile}</span>
            </div>
          ))}
        </section>

        <h2 className={styles.sectionTitle}>版本历史</h2>
        <section className={styles.card}>
          {profiles.slice(0, 12).map((p) => (
            <div key={p.version} className={styles.listItem}>
              <div className={styles.between}>
                <strong className={styles.small}>v{p.version}</strong>
                <span className={`${styles.small} ${styles.muted}`}>{new Date(p.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </div>
              <span className={`${styles.small} ${styles.muted}`}>
                {p.summary} · {p.rules.filter((r) => r.active).length} 条生效
              </span>
            </div>
          ))}
        </section>
      </div>
      <AppNav />
    </main>
  );
}

function RuleEditor(props: {
  value: { id?: string; kind: ProfileRule["kind"]; text: string };
  onChange: (value: { id?: string; kind: ProfileRule["kind"]; text: string }) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  return (
    <div className={styles.stack} style={{ marginTop: 0 }}>
      <select className={styles.select} value={props.value.kind} onChange={(e) => props.onChange({ ...props.value, kind: e.target.value as ProfileRule["kind"] })}>
        <option value="keep">该留</option>
        <option value="drop">该丢</option>
        <option value="style">文风</option>
      </select>
      <input className={styles.input} maxLength={40} value={props.value.text} placeholder="不超过 40 字，比如：拍照打卡的对话不留" onChange={(e) => props.onChange({ ...props.value, text: e.target.value })} />
      <div className={styles.row}>
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={props.busy || !props.value.text.trim()} onClick={props.onSave}>
          保存
        </button>
        <button type="button" className={styles.button} onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
