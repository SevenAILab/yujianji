"use client";

import Dexie, { type Table } from "dexie";
import type { Item, Trip } from "./types";
import { itemSchema } from "./schema";
import type { NativeHealthSample } from "./native-bridge";
import { deviceTimeZone, tzOffsetMinutes } from "./memo/time";
import { DEMO_DAYS, DEMO_VERSION, placeTail, type DemoStop } from "./demo/journal-demo";
import type {
  AgentTrace,
  DiaryDay,
  FeedbackEvent,
  MemoAudio,
  MemoVoiceprint,
  MemoChunk,
  MemoSession,
  MemoWindow,
  Moment,
  Profile,
  TimelineEvent,
  Utterance,
} from "./memo/types";

type SeedMeta = { key: string; value: boolean | string };

/** 照片建成的 3D 模型：任务状态 + 压缩好的 GLB，只存在本机（服务器 2 小时后删） */
export type Model3dRow = {
  itemId: string;
  taskId: string;
  state: "submitted" | "running" | "processing" | "ready" | "failed";
  progress: number;
  error?: string;
  /** 存 ArrayBuffer 不存 Blob：Safari 无痕模式的 IndexedDB 拒收 Blob（WebKit 实测） */
  glb?: ArrayBuffer;
  createdAt: string;
  updatedAt: string;
};

export type PendingEncounterRow = {
  /** current：交给 /encounter 的照片；memo-import：首页「导入」选中、交给 /memo/import 的录音 */
  key: "current" | "memo-import";
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
  source: "camera" | "album" | "insta360" | "home-import";
};

class YujianjiDatabase extends Dexie {
  items!: Table<Item, string>;
  trips!: Table<Trip, string>;
  meta!: Table<SeedMeta, string>;
  healthSamples!: Table<NativeHealthSample & { key: string }, string>;
  pendingEncounters!: Table<PendingEncounterRow, string>;
  // 遇见手记（version 6，只新增表）
  memoSessions!: Table<MemoSession, string>;
  timeline!: Table<TimelineEvent, string>;
  memoChunks!: Table<MemoChunk, [string, number]>;
  memoAudio!: Table<MemoAudio, string>;
  memoVoiceprint!: Table<MemoVoiceprint, string>;
  utterances!: Table<Utterance, string>;
  memoWindows!: Table<MemoWindow, string>;
  moments!: Table<Moment, string>;
  diaryDays!: Table<DiaryDay, string>;
  profiles!: Table<Profile, number>;
  feedbackEvents!: Table<FeedbackEvent, string>;
  agentTraces!: Table<AgentTrace, string>;
  models3d!: Table<Model3dRow, string>;

  constructor() {
    super("yujianji");
    this.version(1).stores({ items: "id,date,country" });
    this.version(2).stores({ items: "id,date,country", meta: "key" });
    this.version(3).stores({ items: "id,date,country", meta: "key", trips: "id,status,startedAt,createdAt" });
    this.version(4).stores({ healthSamples: "key,timestamp,originId,metric" });
    this.version(5).stores({ pendingEncounters: "key" });
    this.version(6).stores({
      memoSessions: "id, status, startedAt",
      timeline: "id, startAt, kind, sessionId",
      memoChunks: "[sessionId+index], sessionId",
      memoAudio: "sessionId",
      utterances: "id, sessionId, expiresAt",
      memoWindows: "id, sessionId",
      moments: "id, sessionId, dayKey, decision",
      diaryDays: "dayKey",
      profiles: "version",
      feedbackEvents: "id, momentId, consumedByVersion",
      agentTraces: "runId, scope, refId, sessionId, dayKey",
    });
    // v7：声纹注册。只新增一张表，老用户的照片和手记都不动。
    this.version(7).stores({ memoVoiceprint: "id" });
    // v8：照片建成的 3D 模型。只新增一张表，老数据不动。
    this.version(8).stores({ models3d: "itemId, state" });
  }
}

export const db = new YujianjiDatabase();

const DEMO_FLAG_KEY = "demo-loaded";

async function fetchSeedItems(): Promise<Item[]> {
  const response = await fetch("/seed-data.json", { cache: "no-store" });
  if (!response.ok) throw new Error("示例内容加载失败");
  const parsed = itemSchema.array().safeParse(await response.json());
  if (!parsed.success) throw new Error("示例内容格式不正确");
  return parsed.data as Item[];
}

/**
 * 示例数据现在是「用户主动打开的展厅」，不是默认灌进个人库的东西。
 *
 * 以前 ensureSeeded() 无条件写入 25 条，新用户第一次打开看到的是别人的地图，
 * 自己的第一条记录淹没在里面。现在默认不灌，首页空状态直接引导去拍第一张。
 */
export async function hasDemoData(): Promise<boolean> {
  try {
    const flag = await db.meta.get(DEMO_FLAG_KEY);
    return flag?.value === true;
  } catch {
    return false;
  }
}

/**
 * 一次性清理：黑客松版本会无条件把 25 条示例灌进每个访客的浏览器。
 * 那些人再打开时，看到的是别人的地图，而不是自己的空白起点 ——
 * 对着公众号二维码扫进来的读者尤其糟。
 *
 * 只删 isSeed 的记录，用户自己拍的一条都不动。
 * 只在从没显式载入过示例时执行一次，之后靠 DEMO_FLAG_KEY 记账，不重复扫库。
 */
export async function clearLegacySeeds(): Promise<number> {
  try {
    const flag = await db.meta.get(DEMO_FLAG_KEY);
    // 显式载入过（true）或已经清理过（false）都不再处理。
    if (flag && (flag.value === true || flag.value === false)) return 0;

    const seeds = await db.items.filter((item) => item.isSeed).toArray();
    if (seeds.length) await db.items.bulkDelete(seeds.map((item) => item.id));
    await db.meta.put({ key: DEMO_FLAG_KEY, value: false });
    if (seeds.length) {
      console.info(JSON.stringify({ event: "legacy_seed_cleared", count: seeds.length }));
    }
    return seeds.length;
  } catch {
    return 0;
  }
}

const DEMO_VERSION_KEY = "demo-version";

/** HH:MM（当地钟点）在设备时区里的那一刻 */
function wallClockIso(dayKey: string, time: string, timeZone: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMinutes(new Date(guess).toISOString(), timeZone) * 60_000).toISOString();
}

/** 全景示例（地球放大后的 360° 入口）仍然来自 seed-data.json；其余示例都来自 DEMO_DAYS */
async function fetchPanoramaSeeds(): Promise<Item[]> {
  try {
    return (await fetchSeedItems()).filter((item) => item.mediaKind === "panorama");
  } catch {
    return [];
  }
}

function demoItem(stop: DemoStop, at: string): Item {
  return {
    id: stop.id,
    name: stop.name,
    category: stop.category,
    photo: stop.photo,
    place: stop.place,
    country: stop.country,
    lat: stop.lat,
    lng: stop.lng,
    locationSource: "exif",
    placeSource: "exif",
    date: at,
    dateSource: "exif",
    userNote: stop.quote,
    ai: {
      cognition: stop.cognition,
      fun: stop.fun,
      luck: stop.luck,
      question: stop.question,
      verdict: "first",
      relatedItemId: null,
      memorySentence: stop.memorySentence,
    },
    isSeed: true,
    createdAt: at,
  };
}

/**
 * 载入示例：每天一条路线，每个点一张照片、一段录音里的原话、一段手帐。
 * 用户自己那天已经有手帐的，跳过那一天，不覆盖。已经载入过旧版示例的，先整套换掉。
 */
let demoLoading: Promise<number> | null = null;

export function loadDemoData(): Promise<number> {
  // 首页和其他页会同时触发换新，只让一次真正执行
  demoLoading ??= loadDemoDataOnce().finally(() => {
    demoLoading = null;
  });
  return demoLoading;
}

async function loadDemoDataOnce(): Promise<number> {
  if (await hasDemoData()) {
    const version = await db.meta.get(DEMO_VERSION_KEY);
    if (version?.value === DEMO_VERSION) return db.items.filter((item) => item.isSeed && item.ai?.verdict === "first").count();
    await removeDemoData();
  }
  const timeZone = deviceTimeZone();
  const taken = new Set((await db.diaryDays.toCollection().primaryKeys()).map(String));
  const panoramas = await fetchPanoramaSeeds();

  const items: Item[] = [];
  const sessions: MemoSession[] = [];
  const utterances: Utterance[] = [];
  const windows: MemoWindow[] = [];
  const moments: Moment[] = [];
  const diaryDays: DiaryDay[] = [];
  for (const day of DEMO_DAYS) {
    if (taken.has(day.dayKey)) continue;
    const runId = `demo-run-${day.dayKey}`;
    const paragraphs: DiaryDay["paragraphs"] = [];
    const quotes: DiaryDay["quotes"] = [];
    let lastAt = "";
    for (const stop of day.stops) {
      const at = wallClockIso(day.dayKey, stop.time, timeZone);
      lastAt = at;
      const sessionId = `demo-session-${stop.id}`;
      const momentId = `demo-moment-${stop.id}`;
      const utteranceId = `${sessionId}:0`;
      const windowId = `${sessionId}:w0`;
      const endedAt = new Date(Date.parse(at) + 45_000).toISOString();
      items.push(demoItem(stop, at));
      sessions.push({
        id: sessionId,
        kind: "import",
        startedAt: at,
        endedAt,
        durationSec: 45,
        timeZone,
        tzOffsetMin: tzOffsetMinutes(at, timeZone),
        startedAtSource: "user",
        status: "ready",
        speakers: [{ key: "0:0", meanDb: null, talkMs: 45_000, role: "me" }],
        meSource: "user",
        meUncertain: false,
        createdAt: at,
        updatedAt: at,
      });
      utterances.push({ id: utteranceId, sessionId, index: 0, beginMs: 0, endMs: 45_000, speakerKey: "0:0", speaker: "me", text: stop.quote, expiresAt: new Date(Date.parse(at) + 7 * 86_400_000).toISOString() });
      windows.push({ id: windowId, sessionId, index: 0, utteranceIds: [utteranceId], beginMs: 0, endMs: 45_000, meChars: stop.quote.length, uncertainChars: 0, triage: { action: "judge", reason: "示例内容", runId }, judge: { status: "done", runId } });
      moments.push({
        id: momentId,
        sessionId,
        windowId,
        dayKey: day.dayKey,
        at,
        place: { name: placeTail(stop.place), source: "backfill", confidence: "high", locked: true },
        decision: "keep",
        salience: 0.82,
        category: stop.agentCategory,
        trigger: stop.name,
        why: stop.why,
        myQuotes: [stop.quote],
        sourceUtteranceIds: [utteranceId],
        photoId: stop.id,
        linkedItemIds: [stop.id],
        user: { copiedCount: 0 },
        runId,
        profileVersion: 1,
        createdAt: at,
      });
      paragraphs.push({ momentId, heading: `${stop.time} · ${placeTail(stop.place)}`, text: stop.text, verified: true, degraded: false, retries: 0 });
      // 金句挑一头一尾：出发时的第一句，收尾时的最后一句
      if (stop === day.stops[0] || stop === day.stops.at(-1)) quotes.push({ momentId, text: stop.quote });
    }
    // 没写进手帐的片段：折叠的进「还有 N 段没写进来」，丢掉的只计数（回执里「丢 N」）
    for (const aside of day.asides ?? []) {
      const at = wallClockIso(day.dayKey, aside.time, timeZone);
      const sessionId = `demo-session-${aside.id}`;
      const utteranceId = `${sessionId}:0`;
      const windowId = `${sessionId}:w0`;
      const text = aside.quote ?? aside.others ?? "";
      sessions.push({ id: sessionId, kind: "import", startedAt: at, endedAt: new Date(Date.parse(at) + 20_000).toISOString(), durationSec: 20, timeZone, tzOffsetMin: tzOffsetMinutes(at, timeZone), startedAtSource: "user", status: "ready", speakers: [{ key: "0:0", meanDb: null, talkMs: 20_000, role: aside.quote ? "me" : "other" }], meSource: "user", meUncertain: false, createdAt: at, updatedAt: at });
      utterances.push({ id: utteranceId, sessionId, index: 0, beginMs: 0, endMs: 20_000, speakerKey: "0:0", speaker: aside.quote ? "me" : "other", text, expiresAt: new Date(Date.parse(at) + 7 * 86_400_000).toISOString() });
      windows.push({ id: windowId, sessionId, index: 0, utteranceIds: [utteranceId], beginMs: 0, endMs: 20_000, meChars: aside.quote?.length ?? 0, uncertainChars: 0, triage: { action: "judge", reason: "示例内容", runId }, judge: { status: "done", runId } });
      moments.push({
        id: `demo-moment-${aside.id}`,
        sessionId,
        windowId,
        dayKey: day.dayKey,
        at,
        decision: aside.decision,
        salience: aside.decision === "fold" ? 0.45 : 0.1,
        category: aside.category,
        trigger: aside.trigger,
        why: aside.why,
        myQuotes: aside.quote ? [aside.quote] : [],
        ...(aside.others ? { othersParaphrase: aside.others } : {}),
        sourceUtteranceIds: [utteranceId],
        user: { copiedCount: 0 },
        runId,
        profileVersion: 1,
        createdAt: at,
      });
    }
    diaryDays.push({
      dayKey: day.dayKey,
      title: day.title,
      quotes,
      paragraphs,
      foldedMomentIds: (day.asides ?? []).filter((aside) => aside.decision === "fold").map((aside) => `demo-moment-${aside.id}`),
      profileVersion: 1,
      generatedAt: new Date(Date.parse(lastAt) + 3 * 3600_000).toISOString(),
      runId,
      status: "ready",
    });
  }

  const tables = [db.items, db.memoSessions, db.utterances, db.memoWindows, db.moments, db.diaryDays, db.timeline, db.meta];
  await db.transaction("rw", tables, async () => {
    await db.items.bulkPut([...panoramas, ...items]);
    await db.memoSessions.bulkPut(sessions);
    await db.utterances.bulkPut(utterances);
    await db.memoWindows.bulkPut(windows);
    await db.moments.bulkPut(moments);
    await db.diaryDays.bulkPut(diaryDays);
    await db.meta.put({ key: DEMO_FLAG_KEY, value: true });
    await db.meta.put({ key: DEMO_VERSION_KEY, value: DEMO_VERSION });
  });
  return items.length;
}

export async function removeDemoData(): Promise<number> {
  const seeds = await db.items.filter((item) => item.isSeed).toArray();
  const sessions = await db.memoSessions.filter((session) => session.id.startsWith("demo-session-")).toArray();
  const sessionIds = sessions.map((session) => session.id);
  const moments = await db.moments.filter((moment) => moment.id.startsWith("demo-moment-")).toArray();
  const momentIds = new Set(moments.map((moment) => moment.id));
  const demoDays = (await db.diaryDays.toArray()).filter((diary) => diary.paragraphs.some((paragraph) => momentIds.has(paragraph.momentId)));
  const tables = [db.items, db.memoSessions, db.utterances, db.memoWindows, db.moments, db.diaryDays, db.timeline, db.meta];
  await db.transaction("rw", tables, async () => {
    await db.items.bulkDelete(seeds.map((item) => item.id));
    if (sessionIds.length) {
      await db.memoSessions.bulkDelete(sessionIds);
      await db.utterances.where("sessionId").anyOf(sessionIds).delete();
      await db.memoWindows.where("sessionId").anyOf(sessionIds).delete();
      await db.timeline.where("sessionId").anyOf(sessionIds).delete();
    }
    if (moments.length) await db.moments.bulkDelete(moments.map((moment) => moment.id));
    for (const diary of demoDays) {
      const paragraphs = diary.paragraphs.filter((paragraph) => !momentIds.has(paragraph.momentId));
      const quotes = diary.quotes.filter((quote) => !momentIds.has(quote.momentId));
      const foldedMomentIds = diary.foldedMomentIds.filter((id) => !momentIds.has(id));
      if (!paragraphs.length && !quotes.length && diary.runId.startsWith("demo-run-")) {
        await db.diaryDays.delete(diary.dayKey);
      } else {
        await db.diaryDays.put({ ...diary, paragraphs, quotes, foldedMomentIds });
      }
    }
    await db.meta.put({ key: DEMO_FLAG_KEY, value: false });
  });
  return seeds.length;
}

/**
 * 保留这个名字是为了不动十几个调用点：现在它只负责把已加载的示例保持最新
 * （全景示例的贴图路径会变），不再凭空往用户库里灌东西。
 */
export async function ensureSeeded(): Promise<boolean> {
  if (!(await hasDemoData())) return false;
  try {
    // 旧版示例（25 张散落的照片、一天一张）整套换成按路线组织的新示例
    const version = await db.meta.get(DEMO_VERSION_KEY);
    if (version?.value !== DEMO_VERSION) {
      await loadDemoData();
      return true;
    }
    const panoramas = await fetchPanoramaSeeds();
    if (panoramas.length) await db.items.bulkPut(panoramas);
    return false;
  } catch {
    // 示例刷新失败不该拦住任何页面。
    return false;
  }
}
