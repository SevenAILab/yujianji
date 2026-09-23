"use client";

import Dexie, { type Table } from "dexie";
import type { Item, Trip } from "./types";
import { itemSchema } from "./schema";
import type { NativeHealthSample } from "./native-bridge";
import { dayKeyIn, deviceTimeZone, tzOffsetMinutes } from "./memo/time";
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

export async function loadDemoData(): Promise<number> {
  if (await hasDemoData()) return db.items.filter((item) => item.isSeed && item.ai?.verdict === "first").count();
  const seedItems = await fetchSeedItems();
  const items = seedItems.filter((item) => item.ai?.verdict === "first");
  const timeZone = deviceTimeZone();
  const usedDays = new Set([
    ...(await db.diaryDays.toCollection().primaryKeys()).map(String),
    ...(await db.items.toArray()).map((item) => dayKeyIn(item.date, timeZone)),
  ]);
  let firstDay = Date.UTC(2026, 7, 1);
  while (Array.from({ length: items.length }, (_, index) => new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10)).some((day) => usedDays.has(day))) {
    firstDay -= items.length * 86_400_000;
  }

  const sessions: MemoSession[] = [];
  const utterances: Utterance[] = [];
  const windows: MemoWindow[] = [];
  const moments: Moment[] = [];
  const diaryDays: DiaryDay[] = [];
  items.forEach((source, index) => {
    const day = new Date(firstDay + index * 86_400_000);
    const localNoon = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0);
    const startedAt = new Date(localNoon - tzOffsetMinutes(new Date(localNoon).toISOString(), timeZone) * 60_000).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + 45_000).toISOString();
    const dayKey = dayKeyIn(startedAt, timeZone);
    const item: Item = { ...source, date: startedAt, createdAt: startedAt };
    const sessionId = `demo-session-${item.id}`;
    const momentId = `demo-moment-${item.id}`;
    const utteranceId = `${sessionId}:0`;
    const windowId = `${sessionId}:w0`;
    const quote = item.userNote || `我第一次注意到${item.name}。`;
    const text = `${quote} ${item.ai?.memorySentence ?? "這一刻值得留在今天的手記裡。"}`.trim();
    const session: MemoSession = {
      id: sessionId,
      kind: "import",
      startedAt,
      endedAt,
      durationSec: 45,
      timeZone,
      tzOffsetMin: tzOffsetMinutes(startedAt, timeZone),
      startedAtSource: "user",
      status: "ready",
      speakers: [{ key: "0:0", meanDb: null, talkMs: 45_000, role: "me" }],
      meSource: "user",
      meUncertain: false,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const moment: Moment = {
      id: momentId,
      sessionId,
      windowId,
      dayKey,
      at: startedAt,
      place: { name: item.place, source: "backfill", confidence: "high", locked: true },
      decision: "keep",
      salience: 0.82,
      category: "first_experience",
      trigger: item.name,
      why: "模拟演示内容：用示例照片和编写的旁白展示从录音到手帐的结构。",
      myQuotes: [quote],
      sourceUtteranceIds: [utteranceId],
      photoId: item.id,
      linkedItemIds: [item.id],
      user: { copiedCount: 0 },
      runId: `demo-run-${item.id}`,
      profileVersion: 1,
      createdAt: startedAt,
    };
    const paragraph = {
      momentId,
      heading: `${item.name} · ${item.place}`,
      text: item.ai?.memorySentence || item.userNote || `第一次遇见${item.name}，我把它和当时的光线一起记了下来。`,
      verified: false,
      degraded: false,
      retries: 0,
    };
    sessions.push(session);
    utterances.push({ id: utteranceId, sessionId, index: 0, beginMs: 0, endMs: 45_000, speakerKey: "0:0", speaker: "me", text, expiresAt: new Date(Date.parse(startedAt) + 7 * 86_400_000).toISOString() });
    windows.push({ id: windowId, sessionId, index: 0, utteranceIds: [utteranceId], beginMs: 0, endMs: 45_000, meChars: text.length, uncertainChars: 0, triage: { action: "judge", reason: "模拟演示数据", runId: `demo-run-${item.id}` }, judge: { status: "done", runId: `demo-run-${item.id}` } });
    moments.push(moment);
    diaryDays.push({ dayKey, title: `演示 · ${item.name} · 那天的手记`, quotes: [{ momentId, text: quote }], paragraphs: [paragraph], foldedMomentIds: [], profileVersion: 1, generatedAt: startedAt, runId: `demo-run-${item.id}`, status: "ready" });
    items[index] = item;
  });

  const tables = [db.items, db.memoSessions, db.utterances, db.memoWindows, db.moments, db.diaryDays, db.timeline, db.meta];
  await db.transaction("rw", tables, async () => {
    await db.items.bulkPut(seedItems);
    await db.items.bulkPut(items);
    await db.memoSessions.bulkPut(sessions);
    await db.utterances.bulkPut(utterances);
    await db.memoWindows.bulkPut(windows);
    await db.moments.bulkPut(moments);
    await db.diaryDays.bulkPut(diaryDays);
    await db.meta.put({ key: DEMO_FLAG_KEY, value: true });
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
    const items = await fetchSeedItems();
    const existing = await db.items.bulkGet(items.map((item) => item.id));
    const missingOrRefreshable = items.filter(
      (item, index) => !existing[index] || item.mediaKind === "panorama",
    );
    if (missingOrRefreshable.length) await db.items.bulkPut(missingOrRefreshable);
    return missingOrRefreshable.length > 0;
  } catch {
    // 示例刷新失败不该拦住任何页面。
    return false;
  }
}
