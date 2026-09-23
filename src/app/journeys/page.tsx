"use client";

// 旅途（9/23 晚改版）：一趟一趟的旅程，每趟里每天是一个点，连成这趟的总览路线；
// 往下每一天各是一张路线拼贴——去了哪几个点、拍了什么、当时说了什么，按时间串起来。
// 顶上保留「今天」卡（今天的录音处理到哪了、生成今天的手帐）。旧版"按年份拼贴"仍收在最底下。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, Mic, RotateCcw } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { AGENT_NAME } from "@/lib/agent-persona";
import { JourneyCollageMap } from "@/components/JourneyCollageMap";
import { KIND_LABEL, STATUS_LABEL } from "@/components/memo/labels";
import { useRecorder } from "@/components/memo/RecorderProvider";
import { useCountryShapes } from "@/components/useCountryShapes";
import { db } from "@/lib/db";
import { buildDayStops, dayCollage, groupTrips, journalDay, routeKm, tripCollage, type JournalDay, type JournalTrip } from "@/lib/journey-days";
import { describeMemoError } from "@/lib/memo/client/api";
import { generateDiary } from "@/lib/memo/client/orchestrator";
import { dayItemRange, itemDayKey } from "@/lib/memo/day-match";
import { effectiveDecision } from "@/lib/memo/select";
import { clockIn, dayKeyIn, deviceTimeZone, shortDay } from "@/lib/memo/time";
import { buildDiaryTimeline, isFirstEncounter } from "@/lib/memo/timeline";
import type { MemoSession } from "@/lib/memo/types";
import styles from "./diary.module.css";

const PROCESSING: MemoSession["status"][] = ["recorded", "uploading", "preparing", "transcribing", "judging"];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return `${m}月${d}日 ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

function rangeLabel(trip: JournalTrip): string {
  const first = trip.days[0].dayKey;
  const last = trip.days.at(-1)!.dayKey;
  const [y1, m1, d1] = first.split("-").map(Number);
  const [, m2, d2] = last.split("-").map(Number);
  if (first === last) return `${y1}年${m1}月${d1}日`;
  return m1 === m2 ? `${y1}年${m1}月${d1}日 – ${d2}日` : `${y1}年${m1}月${d1}日 – ${m2}月${d2}日`;
}

export default function JourneysPage() {
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [today, setToday] = useState("");
  useEffect(() => {
    const tz = deviceTimeZone();
    setTimeZone(tz);
    setToday(dayKeyIn(new Date().toISOString(), tz));
  }, []);

  const diaries = useLiveQuery(() => db.diaryDays.orderBy("dayKey").reverse().limit(60).toArray(), [], []);
  const dayKeys = useMemo(() => diaries.map((diary) => diary.dayKey), [diaries]);
  const moments = useLiveQuery(() => (dayKeys.length ? db.moments.where("dayKey").anyOf(dayKeys).toArray() : []), [dayKeys.join(",")], []);
  // 照片按日期范围查（不整表读），再按设备时区精确归到某一天
  const items = useLiveQuery(
    () => (dayKeys.length ? db.items.where("date").between(dayItemRange(dayKeys.at(-1)!)[0], dayItemRange(dayKeys[0])[1], true, true).toArray() : []),
    [dayKeys.join(",")],
    [],
  );

  const trips = useMemo(() => {
    const days: JournalDay[] = diaries.map((diary) => {
      const dayMoments = moments.filter((moment) => moment.dayKey === diary.dayKey);
      const dayItems = items.filter((item) => itemDayKey(item, timeZone) === diary.dayKey || dayMoments.some((moment) => moment.photoId === item.id));
      const timeline = buildDiaryTimeline({ dayKey: diary.dayKey, paragraphs: diary.paragraphs, moments: dayMoments, items: dayItems, timeZone });
      return journalDay(diary, buildDayStops({ timeline, moments: dayMoments, items: dayItems }));
    });
    return groupTrips(days);
  }, [diaries, moments, items, timeZone]);

  return (
    <main className="app-shell narrative-shell">
      <div className={`phone-page ${styles.page}`}>
        <header className={styles.header}>
          <h1>旅途</h1>
          <p>每天是一条路线：去了哪几个地方，拍下了什么，当时说了什么</p>
        </header>

        {today ? <TodayCard today={today} timeZone={timeZone} hasDiary={diaries.some((d) => d.dayKey === today)} /> : null}

        {trips.map((trip) => (
          <TripSection key={trip.id} trip={trip} timeZone={timeZone} />
        ))}
        {!trips.length ? (
          <div className={styles.empty}>
            <strong>还没有往日的手帐</strong>
            <span>白天在首页拍照、录音，一天结束时小遇会把照片和你说的话整理成一页，串成一条路线。</span>
            <Link href="/" className={styles.ghostButton}>
              去首页记录
            </Link>
          </div>
        ) : null}

      </div>
      <AppNav />
    </main>
  );
}

function TripSection({ trip, timeZone }: { trip: JournalTrip; timeZone: string }) {
  const stops = trip.days.flatMap((day) => day.stops);
  const showOverview = trip.days.length >= 2 && trip.cities >= 2;
  const shapes = useCountryShapes(showOverview ? stops : []);
  const overview = useMemo(() => (showOverview ? tripCollage(trip, shapes) : null), [showOverview, trip, shapes]);
  const centers = trip.days
    .map((day) => day.stops.filter((stop) => typeof stop.lat === "number" && typeof stop.lng === "number") as { lat: number; lng: number }[])
    .filter((points) => points.length)
    .map((points) => ({ lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length, lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length }));
  return (
    <section className={styles.trip} aria-label={`${trip.label}的旅程`}>
      <header className={styles.tripHead}>
        <small>{rangeLabel(trip)}</small>
        <h2>
          {trip.label} · {trip.days.length} 天
        </h2>
        <p>
          {stops.length} 个地点 · {stops.filter((stop) => stop.photo).length} 张照片
        </p>
      </header>
      {overview ? <JourneyCollageMap journey={overview} fit="stops" compact caption={`${trip.label} · ${trip.days.length} 天 · 约 ${Math.round(routeKm(centers))} km`} /> : null}
      <div className={styles.days}>
        {trip.days.map((day, index) => (
          <DayRoute key={day.dayKey} day={day} index={index} timeZone={timeZone} />
        ))}
      </div>
    </section>
  );
}

function DayRoute({ day, index, timeZone }: { day: JournalDay; index: number; timeZone: string }) {
  const collage = useMemo(() => dayCollage(day, timeZone), [day, timeZone]);
  const points = day.stops.filter((stop) => typeof stop.lat === "number" && typeof stop.lng === "number") as { lat: number; lng: number }[];
  const km = routeKm(points);
  return (
    <article className={styles.day}>
      <Link href={`/memo/day/${day.dayKey}`} className={styles.dayHead}>
        <small>
          DAY {index + 1} · {dayLabel(day.dayKey)}
        </small>
        <h3>{day.title}</h3>
      </Link>
      {collage ? (
        <JourneyCollageMap journey={collage} fit="stops" compact caption={`${day.stops.length} 个地点 · ${km >= 1 ? `约 ${Math.round(km)} km` : "步行可达"}`} />
      ) : day.stops.length ? (
        <div className={styles.dayStrip}>
          {day.stops.map((stop) => (
            <Link key={stop.id} href={`/memo/day/${day.dayKey}#${stop.anchor}`}>
              <img src={stop.photo} alt={stop.name} loading="lazy" />
            </Link>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>这天没有带照片的记录。</p>
      )}
      <Link href={`/memo/day/${day.dayKey}`} className={styles.dayOpen}>
        {day.stops.length ? day.stops.map((stop) => stop.spot).join(" → ") : "打开这天的手帐"}
        <ChevronRight size={15} aria-hidden />
      </Link>
    </article>
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
  // 小遇的一句状态：只说能从本机记录确认的事
  const agentLine = hasDiary
    ? `${AGENT_NAME}已经把今天整理成一页手帐`
    : processing
      ? `${AGENT_NAME}还在听 ${processing} 段录音，听完就能整理`
      : hasMaterial
        ? `过了零点再打开，${AGENT_NAME}会自动整理今天；也可以现在就生成`
        : "";

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
          {agentLine ? <p className={styles.agentLine}>{agentLine}</p> : null}
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
