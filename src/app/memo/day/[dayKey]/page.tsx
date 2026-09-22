"use client";

import Link from "next/link";
import { use, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Eye, Pencil, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { CopyButton } from "@/components/memo/CopyButton";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { copyFeedback, deleteMoment, editParagraph, restoreMoment, runReflect, shouldAutoReflect, undoDeleteMoment } from "@/lib/memo/client/learn";
import { confirmBackfill, generateDiary } from "@/lib/memo/client/orchestrator";
import { placeLabel } from "@/lib/memo/place";
import { CATEGORY_LABELS } from "@/lib/memo/schema";
import { effectiveDecision, quotesForWriting, selectForDiary } from "@/lib/memo/select";
import { isDayKey, shortDay } from "@/lib/memo/time";
import type { DiaryParagraph, MemoSession, Moment } from "@/lib/memo/types";
import styles from "../../memo.module.css";

interface Toast {
  message: string;
  action?: { label: string; run: () => Promise<void> | void };
}

export default function DayPage({ params }: { params: Promise<{ dayKey: string }> }) {
  const { dayKey } = use(params);
  const diary = useLiveQuery(async () => (await db.diaryDays.get(dayKey)) ?? null, [dayKey]);
  const moments = useLiveQuery(() => db.moments.where("dayKey").equals(dayKey).toArray(), [dayKey], []);
  const sessionIds = useMemo(() => [...new Set(moments.map((m) => m.sessionId))], [moments]);
  const sessions = useLiveQuery(async () => (await db.memoSessions.bulkGet(sessionIds)).filter((s): s is MemoSession => Boolean(s)), [sessionIds.join(",")], []);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ momentId: string; text: string; before: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const byId = useMemo(() => new Map(moments.map((m) => [m.id, m])), [moments]);
  // 配图：片段上存的是遇见集藏品 id，这里取回照片本身
  const photoIds = useMemo(() => [...new Set(moments.map((m) => m.photoId).filter((id): id is string => Boolean(id)))], [moments]);
  const photos = useLiveQuery(
    async () => new Map((await db.items.bulkGet(photoIds)).filter(Boolean).map((item) => [item!.id, item!])),
    [photoIds.join(",")],
    new Map(),
  );
  const [showFolded, setShowFolded] = useState(false);
  const folded = useMemo(() => {
    const ids = diary?.foldedMomentIds ?? selectForDiary(moments).foldedIds;
    return ids.map((id) => byId.get(id)).filter((m): m is Moment => Boolean(m) && effectiveDecision(m!) !== "drop");
  }, [diary, moments, byId]);
  const uncertainSessions = sessions.filter((s) => s.meUncertain);
  const drawerMoment = drawer ? byId.get(drawer) : undefined;
  const drawerParagraph = drawer ? diary?.paragraphs.find((p) => p.momentId === drawer) : undefined;

  function showToast(next: Toast, ms = 3500) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }

  async function maybeLearn() {
    try {
      if (!(await shouldAutoReflect())) return;
      showToast({ message: "攒够 3 次操作了，它在从中学习…" }, 20_000);
      const result = await runReflect();
      showToast({ message: result.changed ? `它学到了：${result.summary}` : `证据还不够，先不改规则：${result.summary}` }, 6000);
    } catch (cause) {
      showToast({ message: `学习没成功：${describeMemoError(cause)}` });
    }
  }

  async function regenerate() {
    setBusy(true);
    setError("");
    try {
      await generateDiary(dayKey);
    } catch (cause) {
      setError(describeMemoError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(momentId: string) {
    const event = await deleteMoment(momentId);
    showToast({ message: "已删除这段", action: { label: "撤销", run: () => undoDeleteMoment(event.id, momentId) } }, 5000);
    void maybeLearn();
  }

  if (!isDayKey(dayKey)) return <Shell>日期格式不对。</Shell>;

  return (
    <Shell>
      <p className={`${styles.small} ${styles.muted}`} style={{ margin: "8px 0 0" }}>
        {shortDay(dayKey)} · 今日手记
      </p>
      <h1 className={styles.diaryTitle}>{diary?.title ?? `${shortDay(dayKey)} 的手记`}</h1>

      {diary?.status === "partial" ? (
        <div className={styles.warning} style={{ marginTop: 8 }}>
          有录音或片段处理失败，这篇手记只包含成功的部分。<Link href="/memo">去首页重试</Link>
        </div>
      ) : null}
      {uncertainSessions.map((s) => (
        <div key={s.id} className={styles.warning} style={{ marginTop: 8 }}>
          有一段录音拿不准哪位是你，那些话先放在折叠区。<Link href={`/memo/session/${s.id}`}>一键纠正</Link>
        </div>
      ))}

      {!diary && moments.length ? (
        <div className={styles.notice} style={{ marginTop: 12 }}>
          这天有 {moments.filter((m) => effectiveDecision(m) === "keep").length} 段留下的片段，还没写成手记。
        </div>
      ) : null}
      {!moments.length ? <div className={styles.notice} style={{ marginTop: 12 }}>这天还没有留下的片段。</div> : null}

      {diary?.quotes.length ? (
        <section className={styles.quotes} aria-label="今日金句">
          {diary.quotes.map((q) => (
            <div key={q.momentId} className={styles.quote}>
              <span>{q.text}</span>
              <CopyButton text={q.text} label="复制" onCopied={() => void copyFeedback(q.momentId, "quote").then(maybeLearn)} />
            </div>
          ))}
        </section>
      ) : null}

      <div className={styles.diaryBody}>
        {diary?.paragraphs.map((p) => (
          <ParagraphCard
            key={p.momentId}
            paragraph={p}
            moment={byId.get(p.momentId)}
            photo={(() => {
              const id = byId.get(p.momentId)?.photoId;
              return id ? photos.get(id) : undefined;
            })()}
            editing={editing?.momentId === p.momentId ? editing : null}
            onEdit={() => setEditing({ momentId: p.momentId, text: p.text, before: p.text })}
            onEditChange={(text) => setEditing((e) => (e ? { ...e, text } : e))}
            onEditCancel={() => setEditing(null)}
            onEditSave={async () => {
              if (!editing) return;
              await editParagraph(editing.momentId, editing.before, editing.text);
              setEditing(null);
              void maybeLearn();
            }}
            onOpen={() => setDrawer(p.momentId)}
            onDelete={() => void onDelete(p.momentId)}
            onCopied={() => void copyFeedback(p.momentId, "paragraph").then(maybeLearn)}
            onPickBackfill={async (target) => {
              await confirmBackfill(p.momentId, target);
              showToast({ message: `已挂回 ${shortDay(target.dayKey)}${target.place ? ` · ${target.place}` : ""}，去那天重新生成手记` });
            }}
          />
        ))}
      </div>

      {diary?.paragraphs.length ? <p className={styles.diaryEnd}>· · ·</p> : null}

      {/* 以下都是次级入口：手记本身要干净，但删改捞回是它学习的唯一来源，不能没有 */}
      <div className={styles.row} style={{ marginTop: 28 }}>
        {moments.length ? (
          <button type="button" className={`${styles.button} ${diary ? "" : styles.buttonPrimary}`} onClick={() => void regenerate()} disabled={busy}>
            <RefreshCw size={13} /> {busy ? "正在写…" : diary ? "重新生成" : "生成今日手记"}
          </button>
        ) : null}
        {folded.length ? (
          <button type="button" className={styles.button} onClick={() => setShowFolded((v) => !v)} aria-expanded={showFolded}>
            还有 {folded.length} 段没写进来
          </button>
        ) : null}
        {diary?.runId ? (
          <Link className={styles.button} href={`/memo/trace/${encodeURIComponent(diary.runId)}`}>
            写作与自查过程
          </Link>
        ) : null}
      </div>
      {error ? <div className={styles.warning} style={{ marginTop: 10 }}>{error}</div> : null}

      {folded.length && showFolded ? (
        <>
          <section className={styles.card} style={{ marginTop: 12 }}>
            {folded.map((m) => (
              <div key={m.id} className={styles.listItem}>
                <div className={styles.between}>
                  <strong className={styles.small}>{m.trigger}</strong>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() =>
                      void restoreMoment(m.id).then(() => {
                        showToast({ message: "已捞回，先显示整理后的原话，重新生成时再写" });
                        void maybeLearn();
                      })
                    }
                  >
                    捞回
                  </button>
                </div>
                <span className={`${styles.small} ${styles.muted}`}>
                  {CATEGORY_LABELS[m.category]} · {m.why}
                </span>
                {m.myQuotes[0] ? <span className={styles.small}>「{m.myQuotes[0].slice(0, 60)}」</span> : null}
                {!m.myQuotes.length && m.uncertainQuotes?.[0] ? (
                  <span className={styles.small}>
                    <span className={`${styles.badge} ${styles.badgeWarn}`}>可能是你说的</span> 「{m.uncertainQuotes[0].slice(0, 60)}」
                  </span>
                ) : null}
              </div>
            ))}
          </section>
        </>
      ) : null}

      {drawerMoment ? (
        <div className={styles.drawerBackdrop} role="dialog" aria-modal onClick={() => setDrawer(null)}>
          <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.between}>
              <strong style={{ fontFamily: "var(--serif)" }}>看原话</strong>
              <button type="button" className={`${styles.button} ${styles.buttonGhost}`} onClick={() => setDrawer(null)}>
                关闭
              </button>
            </div>
            {drawerParagraph?.degraded ? <p className={`${styles.small} ${styles.muted}`}>这一段没通过自查，正文显示的是整理后的原话（未润色）。</p> : null}
            <h3 className={styles.sectionTitle}>我的原话</h3>
            {quotesForWriting(drawerMoment).map((q, i) => (
              <p key={i} className={styles.quoteLine}>
                {q}
              </p>
            ))}
            {!drawerMoment.user.speakerConfirmed && drawerMoment.uncertainQuotes?.length ? (
              <>
                <h3 className={styles.sectionTitle}>可能是你说的（说话人拿不准）</h3>
                {drawerMoment.uncertainQuotes.map((q, i) => (
                  <p key={i} className={styles.quoteLine}>
                    {q}
                  </p>
                ))}
              </>
            ) : null}
            {drawerMoment.othersParaphrase ? (
              <>
                <h3 className={styles.sectionTitle}>同伴的话（转述）</h3>
                <p className={styles.quoteLine}>{drawerMoment.othersParaphrase}</p>
              </>
            ) : null}
            {drawerMoment.facts?.length ? (
              <>
                <h3 className={styles.sectionTitle}>AI 补充，未经核实</h3>
                {drawerMoment.facts.map((f) => (
                  <p key={f.entity} className={styles.fact}>
                    {f.entity}：{f.fact}
                  </p>
                ))}
              </>
            ) : null}
            <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 12 }}>
              为什么留下：{drawerMoment.why}（{CATEGORY_LABELS[drawerMoment.category]}）
            </p>
            <Link className={styles.button} href={`/memo/session/${drawerMoment.sessionId}`}>
              看整段逐字稿
            </Link>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={styles.toast} role="status">
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                void toast.action!.run();
                setToast(null);
              }}
            >
              <Undo2 size={13} /> {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </Shell>
  );
}

function ParagraphCard(props: {
  paragraph: DiaryParagraph;
  moment?: Moment;
  photo?: { id: string; name: string; photo: string };
  editing: { text: string } | null;
  onEdit: () => void;
  onEditChange: (text: string) => void;
  onEditCancel: () => void;
  onEditSave: () => Promise<void>;
  onOpen: () => void;
  onDelete: () => void;
  onCopied: () => void;
  onPickBackfill: (target: { dayKey: string; place?: string }) => Promise<void>;
}) {
  const { paragraph: p, moment: m, photo } = props;
  const backfill = m?.backfill;
  return (
    <article className={styles.diaryEntry}>
      <h3 className={styles.diaryStamp}>{p.heading}</h3>
      {photo ? (
        // 没配到图就什么都不放——留白好过占位灰块
        <img className={styles.diaryPhoto} src={photo.photo} alt={photo.name} loading="lazy" />
      ) : null}
      {backfill ? (
        <p className={`${styles.small} ${styles.muted}`} style={{ margin: "0 0 6px" }}>
          这段说的是 {shortDay(backfill.targetDayKey)}
          {backfill.targetPlace ? ` · ${backfill.targetPlace}` : ""}
          {backfill.confirmedByUser ? "（你确认过）" : ""}
        </p>
      ) : null}
      {backfill?.candidates?.length && !backfill.confirmedByUser ? (
        <div className={styles.row} style={{ marginBottom: 8 }}>
          <span className={`${styles.small} ${styles.muted}`}>它拿不准挂回哪里，选一个：</span>
          {backfill.candidates.map((c) => (
            <button key={`${c.dayKey}-${c.place}`} type="button" className={styles.badge} onClick={() => void props.onPickBackfill({ dayKey: c.dayKey, place: c.place })}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      {props.editing ? (
        <>
          <textarea className={styles.textarea} value={props.editing.text} onChange={(e) => props.onEditChange(e.target.value)} />
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => void props.onEditSave()}>
              保存
            </button>
            <button type="button" className={styles.button} onClick={props.onEditCancel}>
              取消
            </button>
          </div>
        </>
      ) : (
        <p className={styles.diaryText}>{p.text}</p>
      )}
      {/* 原话、改写、删除、复制全部收在这里：页面要干净，但这些操作是它学习的唯一来源 */}
      {!props.editing ? (
        <details className={styles.entryMore}>
          <summary className={styles.entryMoreSummary} aria-label="这一段的操作">···</summary>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={props.onOpen}>
              <Eye size={13} /> 看原话
            </button>
            <CopyButton text={p.text} onCopied={props.onCopied} />
            <button type="button" className={styles.button} onClick={props.onEdit}>
              <Pencil size={13} /> 改写
            </button>
            <button type="button" className={`${styles.button} ${styles.buttonDanger}`} onClick={props.onDelete}>
              <Trash2 size={13} /> 删除
            </button>
          </div>
          {m?.facts?.length ? (
            <p className={styles.fact}>AI 补充，未经核实：{m.facts.map((f) => f.fact).join("；")}</p>
          ) : null}
          {m ? <p className={styles.why}>为什么留下：{m.why} · {placeLabel(m.place)}</p> : null}
          {p.degraded ? <p className={styles.why}>这段没润色，直接用的你的原话。</p> : null}
          {p.userEdited ? <p className={styles.why}>这段你改过措辞。</p> : null}
        </details>
      ) : null}
    </article>
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
