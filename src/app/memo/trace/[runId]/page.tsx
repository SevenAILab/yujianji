"use client";

import Link from "next/link";
import { use } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatYuan, STEP_LABEL } from "@/components/memo/labels";
import { db } from "@/lib/db";
import styles from "../../memo.module.css";

const SCOPE_LABEL = { pipeline: "录音处理", triage: "粗筛", judge: "Agent 判断", match: "日终配图", write: "写作与自查", reflect: "反思学习" } as const;
const LIMIT_LABEL = { steps: "步数上限", tool_calls: "工具调用上限", deadline: "整轮截止时间" } as const;

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function TracePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: raw } = use(params);
  const runId = decode(raw);
  const trace = useLiveQuery(async () => (await db.agentTraces.get(runId)) ?? null, [runId]);

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href={trace?.sessionId ? `/memo/session/${trace.sessionId}` : trace?.dayKey ? `/memo/day/${trace.dayKey}` : "/memo"}>
            <ChevronLeft size={16} /> 返回
          </Link>
          <span className={`${styles.small} ${styles.muted}`}>过程页</span>
        </div>
        {trace === undefined ? <p>加载中…</p> : null}
        {trace === null ? <div className={styles.notice} style={{ marginTop: 12 }}>这台手机上没有这次运行的记录（{runId}）。</div> : null}
        {trace ? (
          <>
            <h1 className={styles.title}>{SCOPE_LABEL[trace.scope]}</h1>
            <p className={styles.subtitle}>
              {new Date(trace.startedAt).toLocaleString("zh-CN", { hour12: false })} · {trace.model ?? "—"} · {trace.runId}
            </p>
            <section className={`${styles.card} ${styles.stats}`} style={{ marginTop: 14 }}>
              <div className={styles.stat}>
                <strong>{(trace.ms / 1000).toFixed(1)}s</strong>
                <span>耗时</span>
              </div>
              <div className={styles.stat}>
                <strong>{formatYuan(trace.costYuan)}</strong>
                <span>{trace.costEstimated ? "费用（含估算）" : "费用"}</span>
              </div>
              <div className={styles.stat}>
                <strong>{trace.steps.filter((s) => s.kind === "tool").length}</strong>
                <span>工具调用</span>
              </div>
            </section>
            <div className={styles.row} style={{ marginTop: 10 }}>
              <span className={`${styles.badge} ${trace.outcome === "ok" ? styles.badgeOk : styles.badgeWarn}`}>
                {trace.outcome === "ok" ? "正常结束" : trace.outcome === "degraded" ? "有降级（已标出）" : "失败"}
              </span>
              {trace.limitHit ? <span className={`${styles.badge} ${styles.badgeWarn}`}>触发{LIMIT_LABEL[trace.limitHit]}</span> : null}
            </div>
            <h2 className={styles.sectionTitle}>每一步</h2>
            <section className={styles.card}>
              {trace.steps.map((step, i) => (
                <div key={i} className={styles.step}>
                  <span className={styles.stepKind} data-kind={step.kind}>
                    {STEP_LABEL[step.kind]}
                  </span>
                  <div>
                    <div className={styles.stepMeta}>
                      {step.name} · {step.ms}ms
                      {step.inputTokens !== undefined ? ` · 输入 ${step.inputTokens} / 输出 ${step.outputTokens ?? 0} tokens` : ""}
                    </div>
                    <p className={styles.stepSummary}>{step.summary}</p>
                    {step.reason ? <p className={`${styles.small} ${styles.muted}`} style={{ margin: "2px 0 0" }}>→ {step.reason}</p> : null}
                  </div>
                </div>
              ))}
            </section>
            <p className={styles.privacy}>过程记录只存在这台手机：不含完整逐字稿和别人的原话，工具参数只保留必要字段并脱敏。</p>
          </>
        ) : null}
      </div>
      <AppNav />
    </main>
  );
}
