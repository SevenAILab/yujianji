"use client";

// 旅途 = 每日手帐（工单 Gate 3）：顶上是「今天」卡（今天的录音处理到哪了、生成今天的手帐），
// 下面是一天一页的手帐列表。旧版"按年份拼贴"收在最底下的折叠区，展开才挂载。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, Mic, RotateCcw } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { LegacyJourneys } from "@/components/LegacyJourneys";
import { KIND_LABEL, STATUS_LABEL } from "@/components/memo/labels";
import { useRecorder } from "@/components/memo/RecorderProvider";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { generateDiary } from "@/lib/memo/client/orchestrator";
import { dayItemRange, itemDayKey } from "@/lib/memo/day-match";
import { effectiveDecision } from "@/lib/memo/select";
import { clockIn, dayKeyIn, deviceTimeZone, shortDay } from "@/lib/memo/time";
import { buildDiaryTimeline, diaryCoverItemId, isFirstEncounter } from "@/lib/memo/timeline";
import type { DiaryDay, MemoSession } from "@/lib/memo/types";
import styles from "./diary.module.css";

const PROCESSING: MemoSession["status"][] = ["recorded", "uploading", "preparing", "transcribing", "judging"];

export default function JourneysPage() {
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [today, setToday] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  useEffect(() => {
    const tz = deviceTimeZone();
    setTimeZone(tz);
    setToday(dayKeyIn(new Date().toISOString(), tz));
  }, []);

  const diaries = useLiveQuery(() => db.diaryDays.orderBy("dayKey").reverse().limit(60).toArray(), [], []);

  return (
    <main className="app-shell">
      <div className={`phone-page ${styles.page}`}>
        <header className={styles.header}>
          <h1>旅途</h1>
          <p>一天一页手帐：你当天拍下的第一次，和你当时说的话</p>
        </header>

        {today ? <TodayCard today={today} timeZone={timeZone} hasDiary={diaries.some((d) => d.dayKey === today)} /> : null}

        <section className={styles.list} aria-label="每日手帐">
          {diaries.filter((d) => d.dayKey !== today).map((diary) => (
            <DiaryCard key={diary.dayKey} diary={diary} timeZone={timeZone} />
          ))}
          {!diaries.filter((d) => d.dayKey !== today).length ? (
            <div className={styles.empty}>
              <strong>还没有往日的手帐</strong>
              <span>白天在首页拍照、录音，一天结束时它会把照片和你说的话整理成一页。</span>
              <Link href="/" className={styles.ghostButton}>
                去首页记录
              </Link>
            </div>
          ) : null}
        </section>

        <details className={styles.legacy} onToggle={(event) => setLegacyOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>旧版旅途（按时间拼贴）</summary>
          {legacyOpen ? <LegacyJourneys /> : null}
        </details>
      </div>
      <AppNav />
    </main>
  );
}

function TodayCard({ today, timeZone, hasDiary }: { today: string; timeZone: string; hasDiary: boolean }) {
  const router = useRouter();
  const recorder = useRecorder();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sessions = useLiveQuery(() => db.memoSessions.orderBy("startedAt").reverse().limit(30).toArray(), [], []);
  const moments = useLiveQuery(() => db.moments.where("dayKey").equals(today).toArray(), [today], []);
  const items = useLiveQuery(() => db.items.where("date").between(...dayItemRange(today), true, true).toArray(), [today], []);

  // 今天的录音；以前没正常结束的也放进来，否则用户找不到入口处理
  const todaySessions = useMemo(
    () => sessions.filter((s) => dayKeyIn(s.startedAt, s.timeZone) === today || (s.status === "recording" && !recorder.isActive(s.id))),
    [sessions, today, recorder],
  );
  const kept = moments.filter((m) => effectiveDecision(m) === "keep").length;
  const firstPhotos = items.filter((item) => isFirstEncounter(item) && itemDayKey(item, timeZone) === today).length;
  const processing = todaySessions.filter((s) => PROCESSING.includes(s.status) || recorder.jobs.some((j) => j.sessionId === s.id && j.status === "processing")).length;
  const hasMaterial = kept > 0 || firstPhotos > 0;

  async function generate() {
    setBusy(true);
    setError("");
    try {
      await generateDiary(today);
      router.push(`/memo/day/${today}`);
    } catch (cause) {
      setError(describeMemoError(cause));
      setBusy(false);
    }
  }

  return (
    <section className={styles.today} aria-label="今天">
      <div className={styles.todayHead}>
        <div>
          <small>今天 · {shortDay(today)}</small>
          <h2>{hasMaterial ? `${firstPhotos} 张第一次 · ${kept} 段留下的话` : "今天还没有记录"}</h2>
        </div>
        {hasDiary ? (
          <Link href={`/memo/day/${today}`} className={styles.ghostButton}>
            看今天的手帐 <ChevronRight size={14} />
          </Link>
        ) : null}
      </div>

      {todaySessions.length ? (
        <ul className={styles.sessions}>
          {todaySessions.map((s) => {
            const job = recorder.jobs.find((j) => j.sessionId === s.id);
            const orphan = s.status === "recording" && !recorder.isActive(s.id);
            const retryable = s.status === "failed" && s.error?.retryable && s.error.code !== "ASR_SUBMIT_UNKNOWN";
            return (
              <li key={s.id}>
                <Mic size={14} aria-hidden />
                <span className={styles.sessionMeta}>
                  {clockIn(s.startedAt, s.timeZone)} · {KIND_LABEL[s.kind]}
                </span>
                <span className={styles.sessionStatus}>
                  {orphan ? "没有正常结束" : job?.status === "processing" ? job.message : recorder.isActive(s.id) && s.status === "recording" ? "录音中" : STATUS_LABEL[s.status]}
                </span>
                {orphan ? (
                  <button type="button" className={styles.linkButton} onClick={() => void recorder.process(s.id)}>
                    处理已录下的部分
                  </button>
                ) : retryable ? (
                  <button type="button" className={styles.linkButton} onClick={() => void recorder.process(s.id)}>
                    <RotateCcw size={12} /> 重试
                  </button>
                ) : s.status === "failed" ? (
                  <Link className={styles.linkButton} href={`/memo/session/${s.id}`}>
                    查看
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {hasMaterial ? (
        <button type="button" className={styles.primaryButton} onClick={() => void generate()} disabled={busy}>
          {busy ? "正在整理…" : processing ? `还有 ${processing} 段在处理，先生成已完成的` : hasDiary ? "重新生成今天的手帐" : "生成今天的手帐"}
        </button>
      ) : (
        <p className={styles.hint}>
          去<Link href="/">首页</Link>拍一张第一次见到的东西，或者录一段此刻的感受。
        </p>
      )}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}

function DiaryCard({ diary, timeZone }: { diary: DiaryDay; timeZone: string }) {
  const moments = useLiveQuery(() => db.moments.where("dayKey").equals(diary.dayKey).toArray(), [diary.dayKey], []);
  const items = useLiveQuery(() => db.items.where("date").between(...dayItemRange(diary.dayKey), true, true).toArray(), [diary.dayKey], []);
  const timeline = useMemo(
    () => buildDiaryTimeline({ dayKey: diary.dayKey, paragraphs: diary.paragraphs, moments, items, timeZone }),
    [diary, moments, items, timeZone],
  );
  const coverId = diaryCoverItemId(timeline);
  const cover = useLiveQuery(async () => (coverId ? (items.find((i) => i.id === coverId) ?? (await db.items.get(coverId))) : undefined), [coverId, items]);
  const paragraphs = timeline.filter((e) => e.kind === "moment").length;
  const photos = timeline.filter((e) => e.kind === "photo" || (e.kind === "moment" && e.photoId)).length;

  return (
    <Link href={`/memo/day/${diary.dayKey}`} className={styles.card}>
      {cover ? <img src={cover.photo} alt={cover.name} className={styles.cover} loading="lazy" /> : <div className={styles.coverEmpty} aria-hidden />}
      <div className={styles.cardBody}>
        <small>{shortDay(diary.dayKey)}</small>
        <h3>{diary.title}</h3>
        <p>
          {paragraphs ? `${paragraphs} 段` : "没有留下的话"}
          {photos ? ` · ${photos} 张照片` : ""}
        </p>
      </div>
      <ChevronRight size={16} className={styles.chevron} aria-hidden />
    </Link>
  );
}
