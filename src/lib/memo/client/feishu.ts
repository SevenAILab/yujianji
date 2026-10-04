"use client";

// 飞书妙记手动导入（外部设备接入工单 v2 Gate 1）：授权 → 列表 → 勾选 → 核对开录时间 → 进现有管线。
// 令牌只存在本机 IndexedDB 的 meta 表（备份不导出、清空本地数据时一起删），请求时放在 Authorization 头里。
import { apiUrl } from "../../app-mode";
import { db } from "../../db";
import { deviceTimeZone } from "../time";
import type { FeishuRecordingTime } from "../feishu-transcript";
import type { MemoSession } from "../types";
import { MemoApiError, memoApi, type TranscribeStatusResponse } from "./api";
import { createSession, ingestExternalTranscript, runPipeline, type PipelineProgress } from "./orchestrator";
import { addTimelineEvent } from "./repo";

const AUTH_KEY = "feishu-auth";

export interface FeishuAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  /** 授权用户在飞书里的名字：文字记录里同名的 @说话人 就是"我" */
  names: string[];
}

export interface FeishuMinuteItem {
  token: string;
  title: string;
  description: string;
}

export interface FeishuPreview {
  token: string;
  title: string;
  durationMs: number | null;
  syncedAt: string | null;
  recording: FeishuRecordingTime | null;
  turns: number;
  speakers: number;
}

export type FeishuTranscriptResponse = TranscribeStatusResponse & { title: string; recording: FeishuRecordingTime | null; durationMs: number | null };

export async function loadFeishuAuth(): Promise<FeishuAuth | null> {
  const row = await db.meta.get(AUTH_KEY).catch(() => undefined);
  if (!row || typeof row.value !== "string") return null;
  try {
    const auth = JSON.parse(row.value) as FeishuAuth;
    return typeof auth.accessToken === "string" ? auth : null;
  } catch {
    return null;
  }
}

async function saveFeishuAuth(auth: FeishuAuth): Promise<void> {
  await db.meta.put({ key: AUTH_KEY, value: JSON.stringify(auth) });
}

export async function forgetFeishuAuth(): Promise<void> {
  await db.meta.delete(AUTH_KEY);
}

export function feishuAuthorizeUrl(): string {
  return apiUrl("/api/memo/feishu/authorize");
}

/** 授权回来后（?connected=1）领一次令牌 */
export async function claimFeishuAuth(): Promise<FeishuAuth> {
  const res = await memoApi.feishuClaim();
  const auth: FeishuAuth = { ...res.tokens, names: res.names ?? [] };
  await saveFeishuAuth(auth);
  return auth;
}

/** 拿一个有效的令牌：快过期就先刷新；刷新不了就要求重新授权 */
async function validAuth(): Promise<FeishuAuth> {
  const auth = await loadFeishuAuth();
  if (!auth) throw new MemoApiError("FEISHU_AUTH_REQUIRED", 401, "还没有授权飞书");
  if (auth.expiresAt - Date.now() > 60_000) return auth;
  if (!auth.refreshToken || (auth.refreshExpiresAt && auth.refreshExpiresAt < Date.now())) {
    throw new MemoApiError("FEISHU_AUTH_EXPIRED", 401, "飞书授权过期了，请重新授权");
  }
  const { tokens } = await memoApi.feishuRefresh(auth.refreshToken);
  const next: FeishuAuth = { ...auth, ...tokens };
  await saveFeishuAuth(next);
  return next;
}

async function withAuth<T>(fn: (auth: FeishuAuth) => Promise<T>): Promise<T> {
  const auth = await validAuth();
  try {
    return await fn(auth);
  } catch (error) {
    // 服务端说过期：清掉本地令牌，让页面显示重新授权
    if (error instanceof MemoApiError && error.code === "FEISHU_AUTH_EXPIRED") await forgetFeishuAuth();
    throw error;
  }
}

/** 列出一段时间内同步到飞书的妙记（飞书只支持按同步时间搜） */
export function listFeishuMinutes(range: { startIso: string; endIso: string }): Promise<{ items: FeishuMinuteItem[]; hasMore: boolean }> {
  return withAuth((auth) => memoApi.feishuMinutes(auth.accessToken, range));
}

export function previewFeishuMinute(token: string): Promise<FeishuPreview> {
  return withAuth((auth) => memoApi.feishuPreview(auth.accessToken, token));
}

/** 已经导入过的妙记（按 externalId 去重） */
export async function importedFeishuTokens(): Promise<Set<string>> {
  const sessions = await db.memoSessions.filter((s) => typeof s.externalId === "string" && s.externalId.startsWith("feishu:")).toArray();
  return new Set(sessions.map((s) => s.externalId!.slice("feishu:".length)));
}

/** 只给整小时的偏移找一个 IANA 时区名（Etc/GMT 的正负号是反的）；本机时区偏移相同就用本机的 */
export function timeZoneForOffset(offsetMin: number, at: string, local = deviceTimeZone()): string {
  const localOffset = -new Date(at).getTimezoneOffset();
  if (localOffset === offsetMin) return local;
  if (offsetMin % 60 !== 0) return local;
  const hours = offsetMin / 60;
  return hours === 0 ? "Etc/GMT" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/**
 * 导入一条：取转写结果（飞书文字记录 + 响度）→ 建会话（开录时间来自文字记录，或用户改过的）→ 写逐字稿 → 跑判断。
 * startedAtOverride：用户在页面上改过的开录时间（ISO）。
 */
export async function importFeishuMinute(
  token: string,
  opts: { startedAtOverride?: string | null; onProgress?: (p: PipelineProgress) => void } = {},
): Promise<MemoSession> {
  const already = await importedFeishuTokens();
  if (already.has(token)) throw new MemoApiError("FEISHU_ALREADY_IMPORTED", 409, "这段录音已经导入过了");
  opts.onProgress?.({ sessionId: "", status: "transcribing", message: "从飞书取文字记录、算谁是你" });
  const transcript = await withAuth((auth) => memoApi.feishuTranscript(auth.accessToken, token, auth.names));
  const recording = transcript.recording;
  const startedAt = opts.startedAtOverride ?? recording?.startedAt;
  if (!startedAt) throw new MemoApiError("FEISHU_TIME_REQUIRED", 400, "文字记录里读不到录音时间，请先填开始录音的时间");
  const durationSec = Math.round((transcript.durationMs ?? (transcript.sentences?.at(-1)?.endMs ?? 0)) / 1000);
  const session = await createSession({
    kind: "feishu",
    startedAt,
    durationSec,
    startedAtSource: opts.startedAtOverride && opts.startedAtOverride !== recording?.startedAt ? "user" : "feishu_note",
    status: "transcribing",
    timeZone: recording ? timeZoneForOffset(recording.tzOffsetMin, startedAt) : undefined,
  });
  try {
    await db.memoSessions.update(session.id, { externalId: `feishu:${token}` });
    await ingestExternalTranscript(session.id, transcript);
    await addTimelineEvent({ kind: "audio", startAt: session.startedAt, endAt: session.endedAt, refId: session.id, sessionId: session.id, source: "import" });
  } catch (error) {
    // 逐字稿没写进去：这条会话没有音频也没有任务号，留着只会卡在"转文字中"，删掉让用户重来
    await db.memoSessions.delete(session.id);
    throw error;
  }
  return runPipeline(session.id, { onProgress: opts.onProgress });
}
