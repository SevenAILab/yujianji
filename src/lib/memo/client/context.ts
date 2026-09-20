"use client";

// 每次请求由前端从 IndexedDB 拼好需要的上下文（D5、spec §4.10 context.ts）。
import { db } from "../../db";
import { activeRules, selectLearnedExamples } from "../learning";
import { buildMemoryIndex } from "../memory-index";
import { placeLabel } from "../place";
import type { JudgeRequest, ReflectRequest, WriteRequest } from "../schema";
import { effectiveDecision, quotesForWriting } from "../select";
import { addMs, clockIn, dayKeyIn, deviceTimeZone } from "../time";
import type { FeedbackEvent, MemoSession, MemoWindow, Moment, MomentCategory, Profile, Utterance } from "../types";
import { momentById } from "./repo";

export const TODAY_KEPT_MAX = 20;
export const WRITE_MAX_MOMENTS = 8;

export function windowPayload(window: MemoWindow, utterances: Map<string, Utterance>): JudgeRequest["window"] {
  return {
    id: window.id,
    utterances: window.utteranceIds
      .map((id) => utterances.get(id))
      .filter((u): u is Utterance => Boolean(u))
      .map((u) => ({ id: u.id, offsetMs: u.beginMs, speaker: u.speaker, text: u.text.slice(0, 2_500) })),
  };
}

function rulesPayload(profile: Profile) {
  return activeRules(profile).map(({ id, kind, text, origin, locked }) => ({ id, kind, text: text.slice(0, 80), origin, locked }));
}

async function nearbyItems(atIso: string): Promise<JudgeRequest["nearbyItems"]> {
  const at = new Date(atIso).getTime();
  const items = await db.items.filter((item) => !item.isSeed && Math.abs(new Date(item.date).getTime() - at) <= 90 * 60_000).limit(40).toArray();
  return items.length ? items.map((item) => ({ id: item.id, name: item.name.slice(0, 80), place: item.place.slice(0, 120), time: item.date.slice(0, 40) })) : undefined;
}

export async function buildJudgeRequest(input: {
  runId: string;
  mode: JudgeRequest["mode"];
  session: MemoSession;
  window: MemoWindow;
  utterances: Map<string, Utterance>;
  profile: Profile;
  sessionNotes: string;
  /** 实验室：只带某个画像版本之前学到的例子 */
  examplesMaxVersion?: number;
}): Promise<JudgeRequest> {
  const { session, window, profile } = input;
  const [allMoments, allEvents] = await Promise.all([db.moments.toArray(), db.feedbackEvents.toArray()]);
  const byId = momentById(allMoments);
  const windowAt = addMs(session.startedAt, window.beginMs);
  const dayKey = dayKeyIn(windowAt, session.timeZone);

  const todayMoments = allMoments
    .filter((m) => m.dayKey === dayKey && m.windowId !== window.id && effectiveDecision(m) === "keep")
    .sort((a, b) => a.at.localeCompare(b.at));
  const todayKept = todayMoments.slice(-TODAY_KEPT_MAX).map((m) => `${clockIn(m.at, session.timeZone)} ${placeLabel(m.place)} ${m.trigger}`.slice(0, 160));
  const prefer = [...new Set(todayMoments.map((m) => m.category))] as MomentCategory[];

  const events =
    input.examplesMaxVersion === undefined
      ? allEvents
      : allEvents.filter((e) => e.consumedByVersion !== undefined && e.consumedByVersion <= input.examplesMaxVersion!);
  const learnedExamples = selectLearnedExamples(events, byId, prefer).map((e) => ({
    ...e,
    trigger: e.trigger.slice(0, 80),
    why: e.why.slice(0, 80),
    quote: e.quote.slice(0, 160),
  }));

  // 补一段要翻全部记忆；普通会话排除本场（本场的片段已经在 todayKept 里）
  const memoryIndex = buildMemoryIndex(allMoments, { excludeSessionId: input.mode === "backfill" ? undefined : session.id });

  return {
    runId: input.runId,
    mode: input.mode,
    session: { id: session.id, kind: session.kind, startedAt: session.startedAt, timeZone: session.timeZone, ...(session.place?.name ? { place: session.place.name.slice(0, 80) } : {}) },
    window: windowPayload(window, input.utterances),
    sessionNotes: input.sessionNotes.slice(0, 400),
    profile: { version: profile.version, rules: rulesPayload(profile) },
    learnedExamples,
    todayKept,
    memoryIndex,
    nearbyItems: await nearbyItems(windowAt).catch(() => undefined),
  };
}

export function buildWriteRequest(input: {
  runId: string;
  dayKey: string;
  moments: Moment[];
  sessions: Map<string, MemoSession>;
  profile: Profile;
  budgetMs?: number;
}): WriteRequest {
  return {
    runId: input.runId,
    dayKey: input.dayKey,
    moments: input.moments.slice(0, WRITE_MAX_MOMENTS).map((m) => {
      const tz = input.sessions.get(m.sessionId)?.timeZone ?? deviceTimeZone();
      return {
        id: m.id,
        heading: `${clockIn(m.at, tz)} · ${placeLabel(m.place)}`.slice(0, 60),
        myQuotes: quotesForWriting(m).map((q) => q.slice(0, 2_500)).slice(0, 30),
        ...(m.othersParaphrase ? { othersParaphrase: m.othersParaphrase.slice(0, 120) } : {}),
        trigger: m.trigger.slice(0, 80),
        salience: m.salience,
        ...(m.user.editedText ? { userEditedText: m.user.editedText.slice(0, 600) } : {}),
      };
    }),
    profile: { version: input.profile.version, rules: rulesPayload(input.profile) },
    ...(input.budgetMs ? { budgetMs: Math.max(5_000, Math.min(55_000, input.budgetMs)) } : {}),
  };
}

export function buildReflectRequest(input: { runId: string; profile: Profile; events: FeedbackEvent[]; moments: Map<string, Moment> }): ReflectRequest {
  return {
    runId: input.runId,
    profile: {
      version: input.profile.version,
      rules: input.profile.rules.map(({ id, kind, text, origin, locked, evidenceMomentIds, active }) => ({
        id,
        kind,
        text: text.slice(0, 80),
        origin,
        locked,
        evidenceMomentIds: evidenceMomentIds.slice(0, 20),
        active,
      })),
    },
    events: input.events
      .filter((e) => input.moments.has(e.momentId))
      .slice(-30)
      .map((e) => {
        const m = input.moments.get(e.momentId)!;
        return {
          id: e.id,
          type: e.type,
          moment: {
            momentId: m.id,
            category: m.category,
            decision: m.decision,
            trigger: m.trigger.slice(0, 80),
            why: m.why.slice(0, 80),
            quotes: quotesForWriting(m).slice(0, 2).map((q) => q.slice(0, 200)),
          },
          ...(e.type === "edit" ? { before: e.before.slice(0, 600), after: e.after.slice(0, 600) } : {}),
        };
      }),
  };
}
