"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, ChevronLeft, Eye, Pencil, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { JourneyCollageMap } from "@/components/JourneyCollageMap";
import { CopyButton } from "@/components/memo/CopyButton";
import { DiaryReceipt } from "@/components/memo/DiaryReceipt";
import { useModelIds } from "@/components/universe/useModelIds";
import { AGENT_NAME } from "@/lib/agent-persona";
import { db } from "@/lib/db";
import { buildDayStops, dayCollage, journalDay, routeKm } from "@/lib/journey-days";
import { describeMemoError } from "@/lib/memo/client/api";
import { copyFeedback, deleteMoment, editParagraph, restoreMoment, runReflect, shouldAutoReflect, undoDeleteMoment } from "@/lib/memo/client/learn";
import { confirmBackfill, generateDiary } from "@/lib/memo/client/orchestrator";
import { placeLabel } from "@/lib/memo/place";
import { diaryReceipt } from "@/lib/memo/receipt";
import { CATEGORY_LABELS } from "@/lib/memo/schema";
import { dayItemRange, itemDayKey } from "@/lib/memo/day-match";
import { dedupePhotos, effectiveDecision, quotesForWriting, selectForDiary } from "@/lib/memo/select";
import { clockIn, dayKeyIn, deviceTimeZone, isDayKey, shortDay } from "@/lib/memo/time";
import { buildDiaryTimeline, isFirstEncounter, momentAnchor, photoAnchor } from "@/lib/memo/timeline";
import type { DiaryParagraph, MemoSession, Moment } from "@/lib/memo/types";
import styles from "../../memo.module.css";

interface Toast {
  message: string;
  action?: { label: string; run: () => Promise<void> | void; kind?: "undo" | "go" };
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
  // 跨窗口去重：同一张照片只给 salience 最高的那一段，其余留白
  const photoByMoment = useMemo(() => dedupePhotos(moments), [moments]);
  // 当天的照片（按日期范围查，不整表读）：给"只拍没说"的照片条目用
  const dayItems = useLiveQuery(() => (isDayKey(dayKey) ? db.items.where("date").between(...dayItemRange(dayKey), true, true).toArray() : []), [dayKey], []);
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const timeline = useMemo(
    () => (diary ? buildDiaryTimeline({ dayKey, paragraphs: diary.paragraphs, moments, items: dayItems, timeZone }) : []),
    [diary, dayKey, moments, dayItems, timeZone],
  );
  const itemById = useMemo(() => new Map(dayItems.map((item) => [item.id, item])), [dayItems]);
  // 这一天的路线：带照片的条目按时间连起来，照片点进去就是下面对应的那一段
  const route = useMemo(() => {
    if (!diary) return null;
    const stops = buildDayStops({ timeline, moments, items: [...dayItems, ...photos.values()] });
    const collage = dayCollage(journalDay(diary, stops), timeZone);
    const points = stops.filter((stop) => typeof stop.lat === "number" && typeof stop.lng === "number") as { lat: number; lng: number }[];
    return collage ? { collage, count: stops.length, km: routeKm(points) } : null;
  }, [diary, timeline, moments, dayItems, photos, timeZone]);
  const firstPhotoCount = useMemo(() => {
    const used = new Set(photoByMoment.values());
    return dayItems.filter((item) => isFirstEncounter(item) && !used.has(item.id) && itemDayKey(item, timeZone) === dayKey).length;
  }, [dayItems, photoByMoment, timeZone, dayKey]);
  const keptCount = moments.filter((m) => effectiveDecision(m) === "keep").length;
  const hasMaterial = moments.length > 0 || firstPhotoCount > 0;
  const hasDemoMaterial = moments.some((moment) => moment.sessionId.startsWith("demo-session-"));

  // 从宇宙跳过来带着 #m-xxx / #p-xxx：内容是异步读出来的，渲染好之后再滚过去
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !timeline.length || typeof window === "undefined") return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    scrolledRef.current = true;
    el.scrollIntoView({ block: "start" });
    el.classList.add(styles.entryFocus);
    window.setTimeout(() => el.classList.remove(styles.entryFocus), 2400);
    // 上面的路线图和照片陆续加载，会把它往下推：3 秒内布局每变一次就重新对齐；用户自己一滑就停
    const started = performance.now();
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    window.addEventListener("touchstart", stop, { once: true, passive: true });
    window.addEventListener("wheel", stop, { once: true, passive: true });
    const observer = new ResizeObserver(() => {
      if (!stopped && performance.now() - started < 3000) el.scrollIntoView({ block: "start" });
    });
    observer.observe(document.body);
    window.setTimeout(() => {
      observer.disconnect();
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("wheel", stop);
    }, 3000);
  }, [timeline]);
  const [showFolded, setShowFolded] = useState(false);
  const folded = useMemo(() => {
    const ids = diary?.foldedMomentIds ?? selectForDiary(moments).foldedIds;
    return ids.map((id) => byId.get(id)).filter((m): m is Moment => Boolean(m) && effectiveDecision(m!) !== "drop");
  }, [diary, moments, byId]);
  const uncertainSessions = sessions.filter((s) => s.meUncertain);
  const failedSession = sessions.find((s) => s.status === "failed");
  // 小遇的整理回执：数字全来自本机记录，不调模型、不写因果
  const receipt = useMemo(() => (diary ? diaryReceipt({ diary, moments, sessions }) : null), [diary, moments, sessions]);
  const router = useRouter();
  const isToday = dayKeyIn(new Date().toISOString(), timeZone) === dayKey;
  // 手帐 → 精神图景：这张照片已经长成 3D 模型的，给一个去看它的入口
  const modelIds = useModelIds();
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
      showToast({ message: `${AGENT_NAME}正在整理你的新偏好…` }, 20_000);
      const result = await runReflect();
      // 只有反思真的改了画像才说"学会了"；否则照实说还没形成规则
      showToast(
        result.changed
          ? { message: `${AGENT_NAME}学会了：${result.summary}`, action: { label: "去看看", kind: "go", run: () => router.push("/memo/me") } }
          : { message: `这次还没有形成新规则：${result.summary}` },
        8000,
      );
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
    showToast({ message: `${AGENT_NAME}收到你的反馈：这段已移除`, action: { label: "撤销", run: () => undoDeleteMoment(event.id, momentId) } }, 5000);
    void maybeLearn();
  }

  if (!isDayKey(dayKey)) return <Shell>日期格式不对。</Shell>;

  return (
    <Shell>
      <p className={`${styles.small} ${styles.muted}`} style={{ margin: "8px 0 0" }}>
        {isToday ? "今天的手帐" : `${Number(dayKey.slice(5, 7))}月${Number(dayKey.slice(8, 10))}日 · 手帐`}
      </p>
      <h1 className={styles.diaryTitle}>{diary?.title ?? `${shortDay(dayKey)} 的手帐`}</h1>

      {receipt && (receipt.kept || receipt.folded || receipt.dropped || receipt.minutes !== null) ? (
        <DiaryReceipt receipt={receipt} dayKey={dayKey} timeZone={timeZone} demo={hasDemoMaterial} />
      ) : null}

      {route ? (
        <div style={{ marginTop: 14 }}>
          <JourneyCollageMap journey={route.collage} fit="stops" caption={`${route.count} 个地点 · ${route.km >= 1 ? `约 ${Math.round(route.km)} km` : "步行可达"}`} />
        </div>
      ) : null}

      {diary?.status === "partial" ? (
        <div className={styles.warning} style={{ marginTop: 8 }}>
          有录音或片段处理失败，这篇手帐只包含成功的部分。{failedSession ? <Link href={`/memo/session/${failedSession.id}`}>去重试</Link> : null}
        </div>
      ) : null}
      {uncertainSessions.map((s) => (
        <div key={s.id} className={styles.warning} style={{ marginTop: 8 }}>
          有一段录音拿不准哪位是你，那些话先放在折叠区。<Link href={`/memo/session/${s.id}`}>一键纠正</Link>
        </div>
      ))}

      {!diary && hasMaterial ? (
        <div className={styles.notice} style={{ marginTop: 12 }}>
          这天有{keptCount ? ` ${keptCount} 段留下的话` : ""}{keptCount && firstPhotoCount ? "、" : ""}{firstPhotoCount ? ` ${firstPhotoCount} 张第一次拍下的照片` : ""}，还没写成手帐。一天结束时会自动整理，也可以现在就生成。
        </div>
      ) : null}
      {!diary && !hasMaterial ? <div className={styles.notice} style={{ marginTop: 12 }}>这天还没有记录。</div> : null}
      {!diary && hasMaterial ? (
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} style={{ marginTop: 12 }} onClick={() => void regenerate()} disabled={busy}>
          <RefreshCw size={13} /> {busy ? "正在整理…" : "生成这天的手帐"}
        </button>
      ) : null}

      {diary?.quotes.length ? (
        <section className={styles.quotes} aria-label="今日金句">
          {diary.quotes.map((q) => (
            <div key={q.momentId} className={styles.quote}>
              <span>{q.text}</span>
              {hasDemoMaterial ? null : <CopyButton text={q.text} label="复制" onCopied={() => void copyFeedback(q.momentId, "quote").then(maybeLearn)} />}
            </div>
          ))}
        </section>
      ) : null}

      <div className={styles.diaryBody}>
        {timeline.map((entry) => {
          if (entry.kind === "photo") {
            const item = itemById.get(entry.itemId);
            return item ? (
              <article key={`p-${entry.itemId}`} id={photoAnchor(entry.itemId)} className={styles.diaryEntry}>
                <h3 className={styles.diaryStamp}>
                  {clockIn(entry.at, timeZone)} · {entry.place || "地点未知"}
                </h3>
                <img className={styles.diaryPhoto} src={item.photo} alt={entry.name} loading="lazy" />
                <p className={styles.photoCaption}>{entry.name}</p>
              </article>
            ) : null;
          }
          const p = entry.paragraph;
          return (
          <ParagraphCard
          key={p.momentId}
          anchorId={momentAnchor(p.momentId)}
          readOnly={hasDemoMaterial}
          inUniverse={(() => {
            const id = photoByMoment.get(p.momentId);
            return id && modelIds.has(id) ? id : undefined;
          })()}
          paragraph={p}
            moment={byId.get(p.momentId)}
            photo={(() => {
              const id = photoByMoment.get(p.momentId);
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
              showToast({ message: `已挂回 ${shortDay(target.dayKey)}${target.place ? ` · ${target.place}` : ""}，去那天重新生成手帐` });
            }}
          />
          );
        })}
      </div>

      {timeline.length ? <p className={styles.diaryEnd}>· · ·</p> : null}
      {diary && !timeline.length ? <div className={styles.notice} style={{ marginTop: 12 }}>这天没有留下的话，也没有第一次拍下的照片。</div> : null}

      {/* 以下都是次级入口：手帐本身要干净，但删改捞回是它学习的唯一来源，不能没有 */}
      <div className={styles.row} style={{ marginTop: 28 }}>
        {diary && hasMaterial && !hasDemoMaterial ? (
          <button type="button" className={styles.button} onClick={() => void regenerate()} disabled={busy}>
            <RefreshCw size={13} /> {busy ? "正在写…" : "重新生成"}
          </button>
        ) : null}
        {folded.length ? (
          <button type="button" className={styles.button} onClick={() => setShowFolded((v) => !v)} aria-expanded={showFolded}>
            还有 {folded.length} 段没写进来
          </button>
        ) : null}
        {diary?.runId && !hasDemoMaterial ? (
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
                    {!hasDemoMaterial ? <button
                      type="button"
                      className={styles.button}
                    onClick={() =>
                      void restoreMoment(m.id).then(() => {
                        showToast({ message: `${AGENT_NAME}收到你的反馈：这段应该留下（先显示原话，重新生成时再写）` });
                        void maybeLearn();
                      })
                    }
                    >
                      捞回
                    </button> : null}
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
              {toast.action.kind === "go" ? <ArrowRight size={13} /> : <Undo2 size={13} />} {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </Shell>
  );
}

function ParagraphCard(props: {
  anchorId: string;
  readOnly: boolean;
  /** 这段配图已经有 3D 模型时，它的 itemId */
  inUniverse?: string;
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
    <article id={props.anchorId} className={styles.diaryEntry}>
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
          <span className={`${styles.small} ${styles.muted}`}>{AGENT_NAME}拿不准挂回哪里，选一个：</span>
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
      {props.inUniverse ? (
        <Link className={styles.universeLink} href={`/universe?focus=${encodeURIComponent(props.inUniverse)}`}>
          在精神图景里看它 ✦
        </Link>
      ) : null}
      {/* 示例天只读：不给任何操作（不写反馈事件），但把"为什么留下"直接露出来，让人看到小遇在判断 */}
      {props.readOnly && m?.why ? <p className={styles.why}>为什么留下：{m.why}</p> : null}
      {/* 原话、改写、删除、复制全部收在这里：页面要干净，但这些操作是它学习的唯一来源 */}
      {!props.editing && !props.readOnly ? (
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
    <main className="app-shell narrative-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/journeys">
            <ChevronLeft size={16} /> 旅途
          </Link>
        </div>
        {children}
      </div>
      <AppNav />
    </main>
  );
}
