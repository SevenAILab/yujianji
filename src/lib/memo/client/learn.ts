"use client";

// 学习闭环（spec §4.8，P1）：反馈事件 → 反思 → 「它眼中的我」新版本；实验室前后对比；手记页的即时反馈效果。
import { nanoid } from "nanoid";
import { db } from "../../db";
import { applyReflectOps, REFLECT_MIN_EVENTS } from "../learning";
import { selectForDiary } from "../select";
import { deviceTimeZone } from "../time";
import type { DiaryDay, FeedbackEvent, Profile, ProfileRule } from "../types";
import { memoApi, type JudgeResponse } from "./api";
import { buildJudgeRequest, buildReflectRequest } from "./context";
import { degradedParagraphFor } from "./orchestrator";
import { latestProfile, momentById, recordFeedback, saveTrace, undoDelete } from "./repo";

const LAST_REFLECT_KEY = "memo-last-reflect-at";

export async function unconsumedEvents(): Promise<FeedbackEvent[]> {
  const events = await db.feedbackEvents.toArray();
  return events.filter((e) => e.consumedByVersion === undefined).sort((a, b) => a.at.localeCompare(b.at));
}

/** 未消费事件 ≥ 3 触发；上次反思之后新增的事件 ≥ 3 才再触发，避免证据不足时反复花钱 */
export async function shouldAutoReflect(): Promise<boolean> {
  const events = await unconsumedEvents();
  if (events.length < REFLECT_MIN_EVENTS) return false;
  const last = await db.meta.get(LAST_REFLECT_KEY);
  const since = typeof last?.value === "string" ? last.value : "";
  return events.filter((e) => e.at > since).length >= REFLECT_MIN_EVENTS;
}

export interface ReflectOutcome {
  profile: Profile;
  changed: boolean;
  summary: string;
  opsCount: number;
  rejected: { op: string; text: string; reason: string }[];
  runId: string;
}

export async function runReflect(): Promise<ReflectOutcome> {
  const profile = await latestProfile();
  const events = await unconsumedEvents();
  if (!events.length) throw new Error("还没有新的操作可以学习：删掉、捞回或复制几段再来。");
  const moments = momentById((await db.moments.bulkGet([...new Set(events.map((e) => e.momentId))])).filter((m): m is NonNullable<typeof m> => Boolean(m)));
  const runId = `r_v${profile.version}_${Date.now().toString(36)}`;
  const res = await memoApi.reflect(buildReflectRequest({ runId, profile, events, moments }));
  await saveTrace(res.trace);
  await db.meta.put({ key: LAST_REFLECT_KEY, value: new Date().toISOString() });
  if (!res.ops.length) {
    // 证据不够：事件保持未消费，攒够了下次再学
    return { profile, changed: false, summary: res.summary, opsCount: 0, rejected: res.rejected, runId: res.trace.runId };
  }
  const next = applyReflectOps(profile, res.ops, { nowIso: new Date().toISOString(), runId: res.trace.runId, summary: res.summary });
  await db.transaction("rw", db.profiles, db.feedbackEvents, async () => {
    await db.profiles.put(next);
    await db.feedbackEvents.bulkPut(events.map((e) => ({ ...e, consumedByVersion: next.version })));
  });
  return { profile: next, changed: true, summary: res.summary, opsCount: res.ops.length, rejected: res.rejected, runId: res.trace.runId };
}

/** 用户直接改「它眼中的我」：生成新版本，来源 user，优先级最高；锁定条款不可改 */
export async function saveUserRule(input: { id?: string; kind: ProfileRule["kind"]; text: string }): Promise<Profile> {
  const profile = await latestProfile();
  const text = input.text.trim().slice(0, 40);
  if (!text) throw new Error("规则不能为空");
  const now = new Date().toISOString();
  const rules = profile.rules.map((r) => ({ ...r }));
  if (input.id) {
    const target = rules.find((r) => r.id === input.id);
    if (!target) throw new Error("规则不存在");
    if (target.locked) throw new Error("隐私和不编造的底线不能改");
    Object.assign(target, { text, kind: input.kind, origin: "user", updatedAt: now });
  } else {
    rules.push({ id: `rule_${nanoid(10)}`, kind: input.kind, text, origin: "user", locked: false, evidenceMomentIds: [], active: true, createdAt: now, updatedAt: now });
  }
  const next: Profile = { version: profile.version + 1, rules, summary: "你手动修改了规则", createdAt: now };
  await db.profiles.put(next);
  return next;
}

export async function setRuleActive(id: string, active: boolean): Promise<Profile> {
  const profile = await latestProfile();
  const target = profile.rules.find((r) => r.id === id);
  if (!target) throw new Error("规则不存在");
  if (target.locked && !active) throw new Error("隐私和不编造的底线不能停用");
  const now = new Date().toISOString();
  const next: Profile = {
    version: profile.version + 1,
    rules: profile.rules.map((r) => (r.id === id ? { ...r, active, origin: r.origin === "seed" ? "user" : r.origin, updatedAt: now } : r)),
    summary: active ? "你重新启用了一条规则" : "你停用了一条规则",
    createdAt: now,
  };
  await db.profiles.put(next);
  return next;
}

// ── 手记页的即时效果（反馈语义表：当前手记列）─────────────────────────────

async function patchDiary(dayKey: string, fn: (diary: DiaryDay) => DiaryDay): Promise<void> {
  const diary = await db.diaryDays.get(dayKey);
  if (diary) await db.diaryDays.put(fn(diary));
}

export async function deleteMoment(momentId: string): Promise<FeedbackEvent> {
  const event = await recordFeedback({ type: "delete", momentId });
  const moment = await db.moments.get(momentId);
  if (moment) {
    await patchDiary(moment.dayKey, (d) => ({
      ...d,
      paragraphs: d.paragraphs.filter((p) => p.momentId !== momentId),
      quotes: d.quotes.filter((q) => q.momentId !== momentId),
      foldedMomentIds: d.foldedMomentIds.filter((id) => id !== momentId),
    }));
  }
  return event;
}

export async function undoDeleteMoment(eventId: string, momentId: string): Promise<void> {
  if (!(await undoDelete(eventId))) return;
  const moment = await db.moments.get(momentId);
  if (!moment) return;
  const moments = await db.moments.where("dayKey").equals(moment.dayKey).toArray();
  const { paragraphIds, foldedIds } = selectForDiary(moments);
  const session = await db.memoSessions.get(moment.sessionId);
  await patchDiary(moment.dayKey, (d) => {
    const inDiary = paragraphIds.includes(momentId) && !d.paragraphs.some((p) => p.momentId === momentId);
    const paragraphs = inDiary ? [...d.paragraphs, degradedParagraphFor(moment, session?.timeZone ?? deviceTimeZone())] : d.paragraphs;
    return { ...d, paragraphs: sortByMoment(paragraphs, moments), foldedMomentIds: foldedIds.filter((id) => !paragraphs.some((p) => p.momentId === id)) };
  });
}

function sortByMoment<T extends { momentId: string }>(items: T[], moments: { id: string; at: string }[]): T[] {
  const at = new Map(moments.map((m) => [m.id, m.at]));
  return [...items].sort((a, b) => (at.get(a.momentId) ?? "").localeCompare(at.get(b.momentId) ?? ""));
}

/** 从折叠区捞回：立即加入正文，先显示整理后的原话（未润色），重新生成时再写 */
export async function restoreMoment(momentId: string): Promise<void> {
  await recordFeedback({ type: "restore", momentId });
  const moment = await db.moments.get(momentId);
  if (!moment) return;
  const session = await db.memoSessions.get(moment.sessionId);
  const moments = await db.moments.where("dayKey").equals(moment.dayKey).toArray();
  const existing = await db.diaryDays.get(moment.dayKey);
  const paragraph = degradedParagraphFor(moment, session?.timeZone ?? deviceTimeZone());
  if (!existing) {
    await db.diaryDays.put({ dayKey: moment.dayKey, title: "今日手记", quotes: [], paragraphs: [paragraph], foldedMomentIds: [], profileVersion: moment.profileVersion, generatedAt: new Date().toISOString(), runId: "", status: "partial" });
    return;
  }
  await patchDiary(moment.dayKey, (d) => ({
    ...d,
    paragraphs: sortByMoment([...d.paragraphs.filter((p) => p.momentId !== momentId), paragraph], moments),
    foldedMomentIds: d.foldedMomentIds.filter((id) => id !== momentId),
  }));
}

export async function copyFeedback(momentId: string, target: "paragraph" | "quote"): Promise<void> {
  await recordFeedback({ type: "copy", momentId, target });
}

export async function editParagraph(momentId: string, before: string, after: string): Promise<void> {
  const text = after.trim();
  if (!text || text === before) return;
  await recordFeedback({ type: "edit", momentId, before, after: text });
  const moment = await db.moments.get(momentId);
  if (!moment) return;
  await patchDiary(moment.dayKey, (d) => ({
    ...d,
    paragraphs: d.paragraphs.map((p) => (p.momentId === momentId ? { ...p, text, userEdited: true, degraded: false } : p)),
  }));
}

// ── 实验室：同一窗口用两个画像版本各跑一次 judge ────────────────────────────

export interface LabRun {
  profileVersion: number;
  result: JudgeResponse | null;
  error?: string;
}

export interface LabComparison {
  windowId: string;
  before: LabRun;
  after: LabRun;
  /** 两个版本判定不同的句子 id */
  changedUtteranceIds: string[];
}

function decisionsByUtterance(result: JudgeResponse | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of result?.moments ?? []) for (const id of m.sourceUtteranceIds) out.set(id, m.decision);
  return out;
}

export async function labCompare(windowId: string, versions: { before: number; after: number }): Promise<LabComparison> {
  const window = await db.memoWindows.get(windowId);
  if (!window) throw new Error("窗口不存在");
  const session = await db.memoSessions.get(window.sessionId);
  if (!session) throw new Error("会话不存在");
  const utterances = new Map((await db.utterances.where("sessionId").equals(session.id).toArray()).map((u) => [u.id, u]));
  if (!window.utteranceIds.some((id) => utterances.has(id))) throw new Error("这个窗口的逐字稿已被清理");
  const [before, after] = await Promise.all([db.profiles.get(versions.before), db.profiles.get(versions.after)]);
  if (!before || !after) throw new Error("画像版本不存在");

  const mode = session.kind === "backfill" ? "backfill" : "session";
  const run = async (profile: Profile): Promise<LabRun> => {
    try {
      const runId = `lab_${window.index}_v${profile.version}_${Date.now().toString(36)}`;
      const request = await buildJudgeRequest({ runId, mode, session, window, utterances, profile, sessionNotes: "", examplesMaxVersion: profile.version });
      const result = await memoApi.judge(request);
      await saveTrace(result.trace);
      return { profileVersion: profile.version, result };
    } catch (error) {
      return { profileVersion: profile.version, result: null, error: error instanceof Error ? error.message : "失败" };
    }
  };
  const [a, b] = await Promise.all([run(before), run(after)]);
  const da = decisionsByUtterance(a.result);
  const dbm = decisionsByUtterance(b.result);
  const changed = window.utteranceIds.filter((id) => (da.get(id) ?? "none") !== (dbm.get(id) ?? "none"));
  return { windowId, before: a, after: b, changedUtteranceIds: changed };
}
