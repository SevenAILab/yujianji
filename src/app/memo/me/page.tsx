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
import { AGENT_NAME } from "@/lib/agent-persona";
import { FEEDBACK_EFFECTS } from "@/lib/memo/feedback";
import { REFLECT_MIN_EVENTS } from "@/lib/memo/learning";
import type { Moment, ProfileRule } from "@/lib/memo/types";
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
  const rules = profile?.rules ?? [];
  const taught = rules.filter((r) => r.origin !== "seed");
  const seeds = rules.filter((r) => r.origin === "seed");
  const lastLearned = profiles.find((p) => p.version > 1);

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
          <Link className={styles.back} href="/me">
            <ChevronLeft size={16} /> 我的
          </Link>
          {/* 前后对比只有学过至少一次才有意义 */}
          {profiles.length > 1 ? (
            <Link className={styles.button} href="/memo/lab">
              学之前 vs 学之后
            </Link>
          ) : null}
        </div>
        <h1 className={styles.title}>{AGENT_NAME}眼中的你</h1>
        <p className={styles.subtitle}>{AGENT_NAME}不每天问你问题，只看你删掉、捞回、复制、改写了什么。每条规则都写明从哪学来，你能改、能停用。</p>

        <section className={styles.card} style={{ marginTop: 14 }}>
          <p style={{ margin: 0, fontFamily: "var(--serif)", fontSize: 16, lineHeight: 1.7 }}>
            {taught.length
              ? profile?.summary
              : `我们刚认识。${AGENT_NAME}先按 ${seeds.length || 17} 条默认规则帮你挑；你删、捞、改、复制的每一下都会记下，攒够 ${REFLECT_MIN_EVENTS} 次就试着学一次。`}
          </p>
          <div className={styles.row} style={{ marginTop: 10 }}>
            <span className={`${styles.small} ${styles.muted}`}>
              已记录反馈 {events.length} 次 · 已形成规则 {taught.length} 条
              {lastLearned ? ` · 最近一次学习 ${new Date(lastLearned.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
            </span>
          </div>
          <div className={styles.between} style={{ marginTop: 10 }}>
            <span className={styles.small}>{unconsumed.length ? `还有 ${unconsumed.length} 次操作没学` : "没有待学的操作"}</span>
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={busy || !unconsumed.length} onClick={() => void act(async () => setResult(await runReflect()))}>
              <Sparkles size={13} /> 让{AGENT_NAME}学习
            </button>
          </div>
          {result ? (
            <div className={result.changed ? styles.notice : styles.warning} style={{ marginTop: 8 }}>
              {result.changed ? `${AGENT_NAME}学会了（第 ${result.profile.version} 版）：${result.summary}` : `这次还没有形成新规则：${result.summary}`}
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

        <h2 className={styles.sectionTitle}>{AGENT_NAME}学会的</h2>
        <section className={styles.card}>
          {taught.length ? (
            taught
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((rule) => <RuleRow key={rule.id} rule={rule} evidence={evidence} editing={editing} setEditing={setEditing} busy={busy} act={act} />)
          ) : (
            <span className={`${styles.small} ${styles.muted}`}>还没有。在手帐里删掉或捞回几段同类内容，这里会出现第一条。</span>
          )}
        </section>

        <details className={styles.card} style={{ marginTop: 14 }}>
          <summary className={styles.small} style={{ cursor: "pointer" }}>
            默认规则（{seeds.length} 条）：刚认识时{AGENT_NAME}按这些挑，底线规则学不走
          </summary>
          {(["drop", "keep", "style"] as const).map((kind) => (
            <div key={kind}>
              <h2 className={styles.sectionTitle}>{RULE_KIND_LABEL[kind]}</h2>
              {seeds
                .filter((r) => r.kind === kind)
                .map((rule) => (
                  <RuleRow key={rule.id} rule={rule} evidence={evidence} editing={editing} setEditing={setEditing} busy={busy} act={act} />
                ))}
            </div>
          ))}
        </details>

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

        <h2 className={styles.sectionTitle}>你的操作，{AGENT_NAME}怎么理解</h2>
        <section className={styles.card}>
          {Object.values(FEEDBACK_EFFECTS).map((effect) => (
            <div key={effect.label} className={styles.listItem}>
              <strong className={styles.small}>{effect.label}</strong>
              <span className={`${styles.small} ${styles.muted}`}>当前手帐：{effect.currentDiary}</span>
              <span className={`${styles.small} ${styles.muted}`}>下次写作：{effect.nextWrite}</span>
              <span className={`${styles.small} ${styles.muted}`}>{AGENT_NAME}眼中的你：{effect.profile}</span>
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

type Editing = { id?: string; kind: ProfileRule["kind"]; text: string } | null;

function RuleRow(props: {
  rule: ProfileRule;
  evidence: Map<string, Moment>;
  editing: Editing;
  setEditing: (value: Editing) => void;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { rule, evidence, editing, setEditing, busy, act } = props;
  return (
    <div className={styles.listItem} style={{ opacity: rule.active ? 1 : 0.5 }}>
      {editing?.id === rule.id ? (
        <RuleEditor value={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={() => void act(async () => { await saveUserRule(editing); setEditing(null); })} busy={busy} />
      ) : (
        <>
          <span style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{rule.text}</span>
          <div className={styles.row}>
            <span className={`${styles.badge} ${rule.origin === "user" ? styles.keep : rule.origin === "learned" ? styles.fold : styles.badgeMuted}`}>{rule.origin === "seed" ? "默认" : ORIGIN_LABEL[rule.origin]}</span>
            {rule.origin !== "seed" ? <span className={`${styles.badge} ${styles.badgeMuted}`}>{RULE_KIND_LABEL[rule.kind]}</span> : null}
            {rule.locked ? (
              <span className={`${styles.badge} ${styles.badgeMuted}`}>
                <Lock size={11} /> 底线，学不走
              </span>
            ) : null}
            {!rule.active ? <span className={`${styles.badge} ${styles.badgeWarn}`}>已停用</span> : null}
            {rule.evidenceMomentIds.length ? (
              <span className={`${styles.small} ${styles.muted}`}>
                来自你 {rule.evidenceMomentIds.length} 次修改：
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
