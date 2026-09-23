"use client";

// 遇见手记的本地数据（D5：Moment、手记、画像、trace 全在 IndexedDB）。
import { nanoid } from "nanoid";
import { db } from "../../db";
import { applyFeedback, canUndoDelete } from "../feedback";
import { seedProfile } from "../learning";
import type { AgentTrace, FeedbackEvent, MemoSession, Moment, Profile, TimelineEvent } from "../types";

export const UTTERANCE_TTL_MS = 7 * 24 * 3600_000;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function latestProfile(): Promise<Profile> {
  const latest = await db.profiles.orderBy("version").last();
  if (latest) return latest;
  const seed = seedProfile(new Date().toISOString());
  await db.profiles.put(seed);
  return seed;
}

export async function saveSession(session: MemoSession): Promise<MemoSession> {
  await db.memoSessions.put(session);
  return session;
}

export async function patchSession(id: string, patch: Partial<MemoSession>): Promise<MemoSession> {
  const current = await db.memoSessions.get(id);
  if (!current) throw new Error("会话不存在");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await db.memoSessions.put(next);
  return next;
}

export async function addTimelineEvent(event: Omit<TimelineEvent, "id">): Promise<TimelineEvent> {
  const row = { ...event, id: `tl_${nanoid(12)}` };
  await db.timeline.put(row);
  return row;
}

export async function saveTrace(trace: AgentTrace | undefined): Promise<void> {
  if (trace?.runId) await db.agentTraces.put(trace);
}

/** 记一条反馈，并在同一个事务里更新片段的用户状态 */
export async function recordFeedback(event: DistributiveOmit<FeedbackEvent, "id" | "at">): Promise<FeedbackEvent> {
  const full = { ...event, id: `fb_${nanoid(12)}`, at: new Date().toISOString() } as FeedbackEvent;
  await db.transaction("rw", db.feedbackEvents, db.moments, async () => {
    const moment = await db.moments.get(full.momentId);
    if (!moment) throw new Error("片段不存在");
    await db.feedbackEvents.put(full);
    await db.moments.put({ ...moment, user: applyFeedback(moment, full) });
  });
  return full;
}

/** 撤销删除：直接删掉这条事件（不算反馈），恢复片段状态 */
export async function undoDelete(eventId: string): Promise<boolean> {
  return db.transaction("rw", db.feedbackEvents, db.moments, async () => {
    const event = await db.feedbackEvents.get(eventId);
    if (!event || !canUndoDelete(event)) return false;
    const moment = await db.moments.get(event.momentId);
    await db.feedbackEvents.delete(eventId);
    if (moment) await db.moments.put({ ...moment, user: { ...moment.user, decision: undefined } });
    return true;
  });
}

/**
 * 打开 /memo 时清理（spec §4.10 + v3 隐私表）：
 * - 逐字稿 7 天后删除（Moment 里只保留 keep/fold 片段中"我"的原话）
 * - 超过 7 天、用户没确认过的"可能是你说的"原话一并清掉（可能是别人的话）
 * - 已经转写完成的会话，手机上的音频分块和音频文件删除
 */
export async function cleanupExpired(now = Date.now()): Promise<{ utterances: number; uncertainQuotes: number; audio: number }> {
  const nowIso = new Date(now).toISOString();
  const expired = (await db.utterances.where("expiresAt").below(nowIso).toArray())
    .filter((utterance) => !utterance.sessionId.startsWith("demo-session-"))
    .map((utterance) => utterance.id);
  if (expired.length) await db.utterances.bulkDelete(expired);

  const cutoff = new Date(now - UTTERANCE_TTL_MS).toISOString();
  const stale = await db.moments.filter((m) => !m.id.startsWith("demo-moment-") && m.createdAt < cutoff && Boolean(m.uncertainQuotes?.length) && !m.user.speakerConfirmed).toArray();
  if (stale.length) await db.moments.bulkPut(stale.map((m) => ({ ...m, uncertainQuotes: [] })));

  const done = await db.memoSessions.filter((s) => s.status === "ready" || s.status === "judging").primaryKeys();
  let audio = 0;
  for (const sessionId of done) {
    audio += await db.memoChunks.where("sessionId").equals(sessionId).delete();
    if (await db.memoAudio.get(sessionId)) {
      await db.memoAudio.delete(sessionId);
      audio += 1;
    }
  }
  return { utterances: expired.length, uncertainQuotes: stale.length, audio };
}

/** 用户删除整场会话：逐字稿、片段、窗口、音频、时间轴一起删；trace 保留（不含原话） */
export async function deleteSession(sessionId: string): Promise<void> {
  await db.transaction("rw", [db.memoSessions, db.utterances, db.memoWindows, db.moments, db.memoChunks, db.memoAudio, db.timeline], async () => {
    await db.utterances.where("sessionId").equals(sessionId).delete();
    await db.memoWindows.where("sessionId").equals(sessionId).delete();
    await db.moments.where("sessionId").equals(sessionId).delete();
    await db.memoChunks.where("sessionId").equals(sessionId).delete();
    await db.memoAudio.delete(sessionId);
    await db.timeline.where("sessionId").equals(sessionId).delete();
    await db.memoSessions.delete(sessionId);
  });
}

export function momentById(moments: Moment[]): Map<string, Moment> {
  return new Map(moments.map((m) => [m.id, m]));
}
