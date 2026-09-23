"use client";

// 会话状态机（spec §4.10、D7）：recording → recorded → uploading → preparing → transcribing → judging → ready | failed。
// 每步结果先落库再进下一步；刷新页面后从当前状态继续；失败显式标出、可重试（D12）。
// 幂等（spec v3 §4.3）：uploadId 在上传前落库；ASR 任务号拿到就落库；已判断完的窗口不重判；runId 稳定，服务端合并重复请求。
import { nanoid } from "nanoid";
import { asrCostYuan } from "../../agent/pricing";
import { db } from "../../db";
import { applyDayMatches, dayItemRange, dayMatchSignature, remainingAfter, selectDayMatchInput } from "../day-match";
import { degradeFromQuotes } from "../fillers";
import { placeAt, placeLabel } from "../place";
import { quotesForWriting, selectForDiary } from "../select";
import { applySpeakerCorrection, assignSpeakerRoles, openingSpeakerKey } from "../speaker";
import { addMs, clockIn, dayKeyIn, deviceTimeZone, shortDay } from "../time";
import type {
  AgentTrace,
  AudioSourceKind,
  DiaryDay,
  MemoSession,
  MemoWindow,
  Moment,
  PipelineStage,
  PlaceRef,
  SessionStatus,
  StageTiming,
  TraceStep,
  Utterance,
} from "../types";
import { shouldSkipWithoutModel, splitWindows } from "../windows";
import { describeMemoError, MemoApiError, memoApi, type JudgeResponse } from "./api";
import { buildJudgeRequest, buildWriteRequest, windowPayload } from "./context";
import { mergeChunks } from "./recorder";
import { addTimelineEvent, latestProfile, patchSession, saveTrace, UTTERANCE_TTL_MS } from "./repo";
import { uploadBlob } from "./upload";

/** 阶段预算（spec v3 §5 时间目标）：超出只标黄，不中断；写作阶段剩余时间不够时服务端跳过重写直接降级 */
export const STAGE_BUDGET_MS: Record<PipelineStage, number> = {
  upload: 20_000,
  prepare: 15_000,
  transcribe: 30_000,
  triage: 5_000,
  judge: 25_000,
  write: 25_000,
};

export interface PipelineProgress {
  sessionId: string;
  status: SessionStatus | "writing";
  message: string;
  done?: number;
  total?: number;
}

export interface PipelineOptions {
  onProgress?: (progress: PipelineProgress) => void;
  /** 从 failed 继续 */
  retry?: boolean;
  /** 用户确认可能重复计费后，强制重新提交语音识别 */
  forceResubmit?: boolean;
  /**
   * 判断完成后立刻写这段所在日子的手帐。默认不写：手帐改成日终统一生成
   * （照片和录音整天一起配），录完只跑到 ready。
   */
  autoDiary?: boolean;
}

const running = new Map<string, Promise<MemoSession>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createSession(input: {
  kind: AudioSourceKind;
  startedAt: string;
  endedAt?: string;
  durationSec: number;
  startedAtSource: MemoSession["startedAtSource"];
  place?: PlaceRef;
  status?: SessionStatus;
  timeZone?: string;
}): Promise<MemoSession> {
  const now = new Date().toISOString();
  const timeZone = input.timeZone ?? deviceTimeZone();
  const session: MemoSession = {
    id: `ses_${nanoid(12)}`,
    kind: input.kind,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? addMs(input.startedAt, input.durationSec * 1000),
    durationSec: input.durationSec,
    timeZone,
    tzOffsetMin: -new Date(input.startedAt).getTimezoneOffset(),
    startedAtSource: input.startedAtSource,
    ...(input.place ? { place: input.place } : {}),
    status: input.status ?? "recorded",
    interruptions: [],
    timings: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.memoSessions.put(session);
  return session;
}

/** 录音 / 导入完成：存音频，写一条 audio 时间轴事件（D1：Agent 不感知来源） */
export async function finalizeAudio(sessionId: string, blob: Blob, mime: string, patch: Partial<MemoSession> = {}): Promise<MemoSession> {
  await db.memoAudio.put({ sessionId, blob, mime, createdAt: new Date().toISOString() });
  const session = await patchSession(sessionId, { ...patch, status: "recorded", mime, sizeBytes: blob.size });
  const existing = await db.timeline.where("sessionId").equals(sessionId).filter((e) => e.kind === "audio").count();
  if (!existing) {
    await addTimelineEvent({ kind: "audio", startAt: session.startedAt, endAt: session.endedAt, refId: sessionId, sessionId, source: session.kind === "in_app" ? "recorder" : "import" });
  }
  return session;
}

export function runPipeline(sessionId: string, opts: PipelineOptions = {}): Promise<MemoSession> {
  const existing = running.get(sessionId);
  if (existing) return existing;
  const job = pipeline(sessionId, opts).finally(() => running.delete(sessionId));
  running.set(sessionId, job);
  return job;
}

export function isPipelineRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

function stageOf(status: SessionStatus): PipelineStage | "record" {
  switch (status) {
    case "recording":
    case "recorded":
      return "record";
    case "uploading":
      return "upload";
    case "preparing":
      return "prepare";
    case "transcribing":
      return "transcribe";
    default:
      return "judge";
  }
}

async function timed(sessionId: string, stage: PipelineStage, fn: () => Promise<void>): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  const session = await db.memoSessions.get(sessionId);
  const timings: StageTiming[] = [...(session?.timings ?? []).filter((t) => t.stage !== stage), { stage, startedAt, ms, overBudget: ms > STAGE_BUDGET_MS[stage] }];
  await patchSession(sessionId, { timings });
}

async function pipeline(sessionId: string, opts: PipelineOptions): Promise<MemoSession> {
  let session = await db.memoSessions.get(sessionId);
  if (!session) throw new Error("会话不存在");
  const progress = (status: PipelineProgress["status"], message: string, done?: number, total?: number) =>
    opts.onProgress?.({ sessionId, status, message, done, total });
  let retry = Boolean(opts.retry);

  try {
    for (let hop = 0; hop < 16; hop += 1) {
      switch (session.status) {
        case "recording":
          session = await recoverRecording(session);
          break;
        case "recorded":
          session = await patchSession(sessionId, { status: "uploading", uploadId: session.uploadId ?? `up_${nanoid(16)}`, error: undefined });
          break;
        case "uploading":
          progress("uploading", "上传录音");
          await timed(sessionId, "upload", () => doUpload(session!, progress));
          session = (await db.memoSessions.get(sessionId))!;
          break;
        case "preparing":
          progress("preparing", "服务器转单声道、上传识别临时存储");
          await timed(sessionId, "prepare", () => doPrepare(session!, progress));
          session = (await db.memoSessions.get(sessionId))!;
          break;
        case "transcribing":
          progress("transcribing", "分说话人转文字");
          await timed(sessionId, "transcribe", () => doTranscribe(session!, progress, Boolean(opts.forceResubmit)));
          session = (await db.memoSessions.get(sessionId))!;
          break;
        case "judging":
          await doJudge(session, progress);
          session = (await db.memoSessions.get(sessionId))!;
          if (session.status === "ready" && opts.autoDiary === true) {
            for (const dayKey of await affectedDays(sessionId)) {
              progress("writing", `写 ${shortDay(dayKey)} 的手记`);
              await generateDiary(dayKey).catch((error) => console.warn("diary failed", describeMemoError(error)));
            }
          }
          break;
        case "ready":
          return session;
        case "failed":
          if (!retry) return session;
          retry = false;
          session = await resumeFromFailure(session);
          break;
      }
    }
    return session;
  } catch (error) {
    if (error instanceof MemoApiError) await saveTrace(error.trace);
    const code = error instanceof MemoApiError ? error.code : "CLIENT_ERROR";
    const step = stageOf(session.status);
    return patchSession(sessionId, {
      status: "failed",
      error: { step, code, message: describeMemoError(error), retryable: code !== "FFMPEG_FAILED" && code !== "NO_AUDIO" },
    });
  }
}

async function recoverRecording(session: MemoSession): Promise<MemoSession> {
  // 录音中刷新页面或崩溃：已存的块照常处理（spec §7）
  const blob = await mergeChunks(session.id);
  if (!blob) throw new MemoApiError("NO_AUDIO", 0, "录音没有留下任何分块");
  return finalizeAudio(session.id, blob, blob.type || "audio/mp4", {
    endedAt: new Date().toISOString(),
    interruptions: [...(session.interruptions ?? []), new Date().toISOString()],
  });
}

async function resumeFromFailure(session: MemoSession): Promise<MemoSession> {
  const code = session.error?.code;
  const step = session.error?.step;
  const hasAudio = Boolean(await db.memoAudio.get(session.id)) || (await db.memoChunks.where("sessionId").equals(session.id).count()) > 0;
  if ((code === "NOT_FOUND" || code === "BAD_UPLOAD_ID") && (step === "prepare" || step === "transcribe" || step === "upload")) {
    // 服务端丢了这次上传（清理、换服务器）：有 taskId 就凭任务号取结果，否则用手机里的音频重新上传
    if (session.asrTaskIds?.length && step === "transcribe") return patchSession(session.id, { status: "transcribing", error: undefined });
    if (!hasAudio) throw new MemoApiError("NO_AUDIO", 0, "手机里的音频已经删除，无法重新处理这段录音");
    return patchSession(session.id, { status: "uploading", uploadId: `up_${nanoid(16)}`, parts: undefined, asrTaskIds: undefined, error: undefined });
  }
  const statusByStep: Record<string, SessionStatus> = {
    record: hasAudio ? "recorded" : "failed",
    import: "recorded",
    upload: "uploading",
    prepare: "preparing",
    transcribe: "transcribing",
    triage: "judging",
    judge: "judging",
    write: "ready",
  };
  const status = statusByStep[step ?? "judge"] ?? "judging";
  if (status === "failed") throw new MemoApiError("NO_AUDIO", 0, "录音没有留下任何分块");
  return patchSession(session.id, { status, error: undefined });
}

async function doUpload(session: MemoSession, progress: (s: PipelineProgress["status"], m: string, d?: number, t?: number) => void): Promise<void> {
  const audio = (await db.memoAudio.get(session.id)) ?? null;
  const blob = audio?.blob ?? (await mergeChunks(session.id));
  if (!blob || blob.size === 0) throw new MemoApiError("NO_AUDIO", 0, "找不到这段录音的音频");
  const mime = audio?.mime ?? session.mime ?? blob.type ?? "audio/mp4";
  const uploadId = session.uploadId!;
  // 声纹注册过就带上那段音频，服务端会拼到每个 ASR 分段前面用来定"我"
  const voiceprint = await db.memoVoiceprint.get("me").catch(() => undefined);
  const result = await uploadBlob({
    uploadId,
    blob,
    mime,
    ...(voiceprint?.blob ? { enroll: { blob: voiceprint.blob, durationMs: voiceprint.durationMs } } : {}),
    onProgress: (done, total) => progress("uploading", `上传录音 ${done}/${total} 块`, done, total),
  });
  await patchSession(session.id, { status: "preparing", totalChunks: result.totalChunks, confirmedChunks: result.totalChunks });
}

async function doPrepare(session: MemoSession, progress: (s: PipelineProgress["status"], m: string) => void): Promise<void> {
  const uploadId = session.uploadId!;
  await memoApi.prepare(uploadId);
  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60_000) {
    const status = await memoApi.prepareStatus(uploadId);
    if (status.status === "done" && status.parts?.length) {
      await patchSession(session.id, {
        status: "transcribing",
        parts: status.parts.map(({ partIndex, offsetMs, durationMs }) => ({ partIndex, offsetMs, durationMs })),
        ...(status.durationSec && !session.durationSec ? { durationSec: Math.round(status.durationSec) } : {}),
      });
      return;
    }
    if (status.status === "failed") throw new MemoApiError(status.code ?? "PREPARE_FAILED", 502, status.error ?? "转码失败");
    progress("preparing", `服务器处理中（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    await sleep(Date.now() - t0 < 20_000 ? 1_000 : 2_500);
  }
  throw new MemoApiError("PREPARE_TIMEOUT", 504, "服务器处理超时");
}

async function doTranscribe(session: MemoSession, progress: (s: PipelineProgress["status"], m: string) => void, force: boolean): Promise<void> {
  let taskIds = session.asrTaskIds;
  if (!taskIds?.length) {
    const submitted = await memoApi.transcribe(session.uploadId!, force);
    taskIds = submitted.taskIds;
    await patchSession(session.id, { asrTaskIds: taskIds }); // 拿到就落库
  }
  const offsets = (session.parts ?? []).map((p) => p.offsetMs);
  const t0 = Date.now();
  while (Date.now() - t0 < 40 * 60_000) {
    const status = await memoApi.transcribeStatus(session.uploadId!, taskIds, offsets.length ? offsets : taskIds.map(() => 0));
    if (status.status === "failed") throw new MemoApiError(status.code ?? "ASR_FAILED", 502, status.error ?? "语音识别失败");
    if (status.status === "succeeded") {
      await storeTranscript(session, status, Date.now() - t0);
      return;
    }
    progress("transcribing", `分说话人转文字（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    await sleep(Date.now() - t0 < 30_000 ? 1_500 : 3_000);
  }
  throw new MemoApiError("ASR_TIMEOUT", 504, "语音识别超时");
}

async function storeTranscript(session: MemoSession, status: Awaited<ReturnType<typeof memoApi.transcribeStatus>>, waitedMs: number): Promise<void> {
  const stats = status.speakers ?? [];
  // 定"我"的优先级：
  // 1) 声纹注册——服务端把注册音频拼在每个分段前，直接告诉我们每段哪个说话人是"我"，最可靠
  // 2) App 内录音的"开头自报家门"——用户按下录音键后先开口
  // 3) 都没有（比如导入的语音备忘录）→ 退回响度
  const enrolled = status.meSpeakerKeys ?? [];
  const opening = !enrolled.length && session.kind === "in_app" ? openingSpeakerKey(status.sentences ?? []) : null;
  const meKeys = enrolled.length ? enrolled : opening ? [opening] : [];
  const assignment = status.speakersDegraded
    ? { speakers: stats.map((s) => ({ ...s, role: "uncertain" as const })), meSource: "unavailable" as const, meUncertain: true }
    : assignSpeakerRoles(stats, { meKeys, meKeySource: enrolled.length ? "enrolled" : "opening" });
  const roleOf = new Map(assignment.speakers.map((s) => [s.key, s.role]));
  const expiresAt = new Date(Date.now() + UTTERANCE_TTL_MS).toISOString();
  const utterances: Utterance[] = (status.sentences ?? []).map((s, index) => ({
    id: `${session.id}:${index}`,
    sessionId: session.id,
    index,
    beginMs: s.beginMs,
    endMs: s.endMs,
    speakerKey: s.speakerKey,
    speaker: roleOf.get(s.speakerKey) ?? "uncertain",
    text: s.text,
    expiresAt,
  }));
  const windows = splitWindows(session.id, utterances);

  await db.transaction("rw", [db.utterances, db.memoWindows, db.memoAudio, db.memoChunks, db.moments], async () => {
    await db.utterances.where("sessionId").equals(session.id).delete();
    await db.memoWindows.where("sessionId").equals(session.id).delete();
    await db.moments.where("sessionId").equals(session.id).delete();
    await db.utterances.bulkPut(utterances);
    await db.memoWindows.bulkPut(windows);
    // 隐私：音频转成文字后，手机里的音频也删掉
    await db.memoAudio.delete(session.id);
    await db.memoChunks.where("sessionId").equals(session.id).delete();
  });

  const asrSeconds = status.asrSeconds ?? session.durationSec;
  const cost = status.asrCostYuan ?? asrCostYuan(status.asrModel ?? "fun-asr", asrSeconds).yuan;
  const fresh = await db.memoSessions.get(session.id);
  const steps: TraceStep[] = (fresh?.timings ?? []).map((t) => ({
    kind: "stage",
    name: t.stage,
    ms: t.ms ?? 0,
    summary: `${t.stage} ${Math.round((t.ms ?? 0) / 100) / 10} 秒${t.overBudget ? `（超过预算 ${STAGE_BUDGET_MS[t.stage] / 1000} 秒）` : ""}`,
  }));
  steps.push({ kind: "stage", name: "transcribe", ms: waitedMs, summary: `${status.asrModel ?? "fun-asr"} 识别 ${asrSeconds} 秒音频，${utterances.length} 句，${stats.length} 位说话人` });
  steps.push({
    kind: "check",
    name: "speaker",
    ms: 0,
    summary: `定"我"：${assignment.meSource === "loudness" ? "按响度" : assignment.meSource === "single_speaker" ? "只有一位说话人" : "响度不可用"}${assignment.meUncertain ? "，有拿不准的说话人，只能折叠，等你确认" : ""}；响度 ${stats.map((s) => `${s.key}=${s.meanDb ?? "?"}dB`).join(" ")}`,
  });
  steps.push({ kind: "stage", name: "windows", ms: 0, summary: `按停顿切成 ${windows.length} 个窗口` });
  const trace: AgentTrace = {
    runId: `pipe_${session.id}`,
    scope: "pipeline",
    refId: session.id,
    sessionId: session.id,
    startedAt: session.createdAt,
    ms: steps.reduce((sum, s) => sum + s.ms, 0),
    costYuan: Math.round(cost * 1e6) / 1e6,
    model: status.asrModel,
    outcome: status.speakersDegraded ? "degraded" : "ok",
    steps,
  };
  await saveTrace(trace);

  await patchSession(session.id, {
    status: utterances.length ? "judging" : "ready",
    speakers: assignment.speakers,
    meSource: assignment.meSource,
    meUncertain: assignment.meUncertain,
    ...(session.durationSec ? {} : { durationSec: asrSeconds }),
  });
}

function toMoment(
  m: JudgeResponse["moments"][number],
  index: number,
  ctx: { session: MemoSession; window: MemoWindow; utterances: Map<string, Utterance>; timeline: Awaited<ReturnType<typeof timelineFor>>; runId: string; profileVersion: number; mode: "session" | "backfill" },
): Moment {
  const first = ctx.utterances.get(m.sourceUtteranceIds[0]);
  const at = addMs(ctx.session.startedAt, first?.beginMs ?? ctx.window.beginMs);
  let dayKey = dayKeyIn(at, ctx.session.timeZone);
  let place = placeAt(ctx.timeline, at, ctx.session.place);
  let backfill: Moment["backfill"];
  if (ctx.mode === "backfill" && m.decision !== "drop") {
    if (m.backfillTarget && !m.needsPlacePick) {
      dayKey = m.backfillTarget.dayKey;
      if (m.backfillTarget.place) place = { name: m.backfillTarget.place, source: "backfill", confidence: m.backfillTarget.confidence >= 0.8 ? "high" : "medium" };
      backfill = { targetDayKey: m.backfillTarget.dayKey, targetPlace: m.backfillTarget.place, confidence: m.backfillTarget.confidence };
    } else {
      backfill = {
        targetDayKey: m.backfillTarget?.dayKey ?? dayKey,
        targetPlace: m.backfillTarget?.place,
        confidence: m.backfillTarget?.confidence ?? 0,
        candidates: m.backfillCandidates,
      };
    }
  }
  return {
    id: `${ctx.window.id}:m${index}`,
    sessionId: ctx.session.id,
    windowId: ctx.window.id,
    dayKey,
    at,
    ...(place ? { place } : {}),
    decision: m.decision,
    salience: m.salience,
    category: m.category as Moment["category"],
    trigger: m.trigger,
    why: m.why,
    myQuotes: m.myQuotes,
    uncertainQuotes: m.uncertainQuotes,
    speakerUncertain: m.speakerUncertain,
    sourceUtteranceIds: m.sourceUtteranceIds,
    ...(m.othersParaphrase ? { othersParaphrase: m.othersParaphrase } : {}),
    ...(m.facts?.length ? { facts: m.facts } : {}),
    ...(m.photoId ? { photoId: m.photoId } : {}),
    ...(backfill ? { backfill } : {}),
    guardNotes: m.guardNotes,
    user: { copiedCount: 0 },
    runId: ctx.runId,
    profileVersion: ctx.profileVersion,
    createdAt: new Date().toISOString(),
  };
}

async function timelineFor(session: MemoSession) {
  const from = addMs(session.startedAt, -30 * 60_000);
  const to = addMs(session.endedAt, 30 * 60_000);
  return db.timeline.where("startAt").between(from, to, true, true).toArray();
}

async function doJudge(session: MemoSession, progress: (s: PipelineProgress["status"], m: string, d?: number, t?: number) => void): Promise<void> {
  const profile = await latestProfile();
  const windows = await db.memoWindows.where("sessionId").equals(session.id).sortBy("index");
  const utterances = new Map((await db.utterances.where("sessionId").equals(session.id).toArray()).map((u) => [u.id, u]));
  if (windows.length && utterances.size === 0) {
    throw new MemoApiError("TRANSCRIPT_EXPIRED", 0, "逐字稿已超过 7 天被清理，无法重新判断");
  }
  const mode = session.kind === "backfill" ? "backfill" : "session";
  const timeline = await timelineFor(session);

  // 粗筛：并发 4，已有结果的窗口不重跑
  const triageStarted = Date.now();
  const pendingTriage = windows.filter((w) => !w.triage);
  let triaged = 0;
  const queue = [...pendingTriage];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        if (shouldSkipWithoutModel(w)) {
          w.triage = { action: "skip", reason: "你在这段几乎没说话", runId: `t_${w.id}_local` };
        } else {
          try {
            const res = await memoApi.triage({ runId: `t_${w.id}`, window: windowPayload(w, utterances) });
            await saveTrace(res.trace);
            w.triage = { action: res.action, reason: res.reason, runId: res.trace.runId };
          } catch (error) {
            if (error instanceof MemoApiError && (error.code === "BUDGET_EXCEEDED" || error.code === "DAILY_BUDGET_EXHAUSTED")) throw error;
            w.triage = { action: "judge", reason: "粗筛请求失败，交给主模型", runId: `t_${w.id}_failed` };
          }
        }
        await db.memoWindows.put(w);
        triaged += 1;
        progress("judging", `粗筛 ${triaged}/${pendingTriage.length} 段`, triaged, pendingTriage.length);
      }
    }),
  );
  if (pendingTriage.length) {
    const s = await db.memoSessions.get(session.id);
    const ms = Date.now() - triageStarted;
    await patchSession(session.id, { timings: [...(s?.timings ?? []).filter((t) => t.stage !== "triage"), { stage: "triage", startedAt: new Date(triageStarted).toISOString(), ms, overBudget: ms > STAGE_BUDGET_MS.triage }] });
  }

  // 判断：按顺序，本场笔记接力；已判断完的窗口跳过
  const judgeStarted = Date.now();
  const toJudge = windows.filter((w) => w.triage?.action === "judge");
  let notes = "";
  let failed = 0;
  let lastError: unknown = null;
  let done = 0;
  for (const w of toJudge) {
    if (w.judge?.status === "done") {
      notes = w.sessionNotes ?? notes;
      done += 1;
      continue;
    }
    progress("judging", `Agent 判断第 ${done + 1}/${toJudge.length} 段`, done, toJudge.length);
    const attempt = w.judge?.status === "failed" ? `_r${Date.now().toString(36)}` : "";
    const runId = `j_${w.id}_p${profile.version}${attempt}`.replace(/[^A-Za-z0-9_:.-]/g, "");
    try {
      const request = await buildJudgeRequest({ runId, mode, session, window: w, utterances, profile, sessionNotes: notes });
      const res = await memoApi.judge(request);
      await saveTrace(res.trace);
      const moments = res.moments.map((m, i) => toMoment(m, i, { session, window: w, utterances, timeline, runId: res.trace.runId, profileVersion: profile.version, mode }));
      await db.transaction("rw", db.moments, db.memoWindows, async () => {
        const old = await db.moments.where("sessionId").equals(session.id).filter((m) => m.windowId === w.id).primaryKeys();
        await db.moments.bulkDelete(old);
        await db.moments.bulkPut(moments);
        await db.memoWindows.put({ ...w, judge: { status: "done", runId: res.trace.runId }, sessionNotes: res.sessionNotes });
      });
      notes = res.sessionNotes;
    } catch (error) {
      if (error instanceof MemoApiError) await saveTrace(error.trace);
      if (error instanceof MemoApiError && (error.code === "BUDGET_EXCEEDED" || error.code === "DAILY_BUDGET_EXHAUSTED")) throw error;
      failed += 1;
      lastError = error;
      await db.memoWindows.put({ ...w, judge: { status: "failed", runId, error: error instanceof MemoApiError ? error.code : "CLIENT_ERROR" } });
    }
    done += 1;
  }
  const s = await db.memoSessions.get(session.id);
  const ms = Date.now() - judgeStarted;
  const timings = [...(s?.timings ?? []).filter((t) => t.stage !== "judge"), { stage: "judge" as const, startedAt: new Date(judgeStarted).toISOString(), ms, overBudget: toJudge.length > 0 && ms / toJudge.length > STAGE_BUDGET_MS.judge }];
  if (toJudge.length && failed === toJudge.length) {
    await patchSession(session.id, { timings });
    throw lastError;
  }
  await patchSession(session.id, {
    status: "ready",
    timings,
    ...(failed ? { error: { step: "judge", code: "PARTIAL", message: `${failed} 段判断失败，可以在过程页单独重跑`, retryable: true } } : { error: undefined }),
  });
}

async function affectedDays(sessionId: string): Promise<string[]> {
  const moments = await db.moments.where("sessionId").equals(sessionId).toArray();
  return [...new Set(moments.map((m) => m.dayKey))].sort();
}

const diaryInflight = new Map<string, Promise<DiaryDay>>();

/**
 * 日终补配图（工单 Gate 1.2）：给还没配图的片段，从当天还没被占用的照片里补一张。
 * 失败只记 degraded，不拦写手帐；返回值写进 DiaryDay.photoMatch 做幂等。
 */
export async function runDayMatch(dayKey: string, previous?: DiaryDay["photoMatch"]): Promise<NonNullable<DiaryDay["photoMatch"]>> {
  const timeZone = deviceTimeZone();
  const [moments, items] = await Promise.all([db.moments.where("dayKey").equals(dayKey).toArray(), db.items.where("date").between(...dayItemRange(dayKey), true, true).filter((item) => !item.isSeed).toArray()]);
  const sessionIds = [...new Set(moments.map((m) => m.sessionId))];
  const sessions = new Map((await db.memoSessions.bulkGet(sessionIds)).filter((s): s is MemoSession => Boolean(s)).map((s) => [s.id, s]));
  const input = selectDayMatchInput({ dayKey, moments, items, timeZone, momentTimeZone: (m) => sessions.get(m.sessionId)?.timeZone ?? timeZone });
  const signature = dayMatchSignature(input);
  const at = new Date().toISOString();
  if (!input.moments.length || !input.photos.length) return { signature, runId: "", at, outcome: "skipped" };
  // 剩余集合和上次一样：模型已经看过这些、对不上，不再花钱重问
  if (previous && previous.outcome !== "failed" && previous.signature === signature) return previous;

  const runId = `m_${dayKey}_${signature}`;
  try {
    const res = await memoApi.match({ runId, dayKey, moments: input.moments, photos: input.photos });
    await saveTrace(res.trace);
    // 服务端过过一遍守卫，这里拿真实片段再过一遍，模型和网络都不可信
    const applied = applyDayMatches(input, { matches: res.matches });
    const written: typeof applied.accepted = [];
    await db.transaction("rw", db.moments, async () => {
      for (const match of applied.accepted) {
        const current = await db.moments.get(match.momentId);
        if (!current || current.photoId) continue; // 这期间已经有图了，一律不覆盖
        await db.moments.update(match.momentId, { photoId: match.photoId, photoSource: "day_match" });
        written.push(match);
      }
    });
    return { signature: dayMatchSignature(remainingAfter(input, written)), runId, at, outcome: "ok" };
  } catch (error) {
    if (error instanceof MemoApiError) await saveTrace(error.trace);
    console.warn("day match failed", describeMemoError(error));
    return { signature, runId, at, outcome: "failed" };
  }
}

/** 日终生成手帐（手动点、或过零点后首次打开）；也可"重新生成"。只有照片没有片段的日子也能生成。 */
export async function generateDiary(dayKey: string, opts: { budgetMs?: number } = {}): Promise<DiaryDay> {
  const ongoing = diaryInflight.get(dayKey);
  if (ongoing) return ongoing;
  const run = generateDiaryOnce(dayKey, opts);
  const tracked = run.finally(() => {
    if (diaryInflight.get(dayKey) === tracked) diaryInflight.delete(dayKey);
  });
  diaryInflight.set(dayKey, tracked);
  return tracked;
}

async function generateDiaryOnce(dayKey: string, opts: { budgetMs?: number } = {}): Promise<DiaryDay> {
  const previous = await db.diaryDays.get(dayKey);
  const photoMatch = await runDayMatch(dayKey, previous?.photoMatch);
  const moments = await db.moments.where("dayKey").equals(dayKey).toArray();
  const sessionIds = [...new Set(moments.map((m) => m.sessionId))];
  const sessions = new Map((await db.memoSessions.bulkGet(sessionIds)).filter((s): s is MemoSession => Boolean(s)).map((s) => [s.id, s]));
  const windows = await db.memoWindows.where("sessionId").anyOf(sessionIds).toArray();
  const partial = [...sessions.values()].some((s) => s.status === "failed" || s.error?.code === "PARTIAL") || windows.some((w) => w.judge?.status === "failed");
  const byId = new Map(moments.map((m) => [m.id, m]));
  const { paragraphIds, foldedIds } = selectForDiary(moments);
  const chosen = paragraphIds.map((id) => byId.get(id)!).filter((m) => quotesForWriting(m).length > 0);
  const profile = await latestProfile();
  const now = new Date().toISOString();

  if (!chosen.length) {
    const empty: DiaryDay = { dayKey, title: `${shortDay(dayKey)} 的手记`, quotes: [], paragraphs: [], foldedMomentIds: foldedIds, profileVersion: profile.version, generatedAt: now, runId: "", status: partial ? "partial" : "ready", photoMatch };
    await db.diaryDays.put(empty);
    return empty;
  }

  const runId = `w_${dayKey}_${Date.now().toString(36)}`;
  const request = buildWriteRequest({ runId, dayKey, moments: chosen, sessions, profile, budgetMs: opts.budgetMs });
  try {
    const res = await memoApi.write(request);
    await saveTrace(res.trace);
    const diary: DiaryDay = {
      dayKey,
      title: res.title,
      quotes: res.quotes,
      paragraphs: res.paragraphs,
      foldedMomentIds: foldedIds.concat(paragraphIds.filter((id) => !chosen.some((m) => m.id === id))),
      profileVersion: profile.version,
      generatedAt: now,
      runId: res.trace.runId,
      status: partial ? "partial" : "ready",
      photoMatch,
    };
    await db.diaryDays.put(diary);
    return diary;
  } catch (error) {
    if (error instanceof MemoApiError) await saveTrace(error.trace);
    // 写作整体失败：先显示整理后的原话，明确标出（D12）
    const fallback: DiaryDay = {
      dayKey,
      title: `${shortDay(dayKey)} 的手记`,
      quotes: [],
      paragraphs: chosen.map((m) => {
        const tz = sessions.get(m.sessionId)?.timeZone ?? deviceTimeZone();
        return { momentId: m.id, heading: `${clockIn(m.at, tz)} · ${placeLabel(m.place)}`, text: m.user.editedText ?? degradeFromQuotes(quotesForWriting(m)), verified: false, degraded: !m.user.editedText, retries: 0, userEdited: Boolean(m.user.editedText), issues: [`写作失败：${describeMemoError(error)}`] };
      }),
      foldedMomentIds: foldedIds,
      profileVersion: profile.version,
      generatedAt: now,
      runId,
      status: "partial",
      photoMatch,
    };
    await db.diaryDays.put(fallback);
    return fallback;
  }
}

/** 用户一键纠正"谁是我"，然后重新判断这场（spec §4.10 speaker.ts） */
export async function correctSpeakers(sessionId: string, meKeys: string[], opts: PipelineOptions = {}): Promise<MemoSession> {
  const session = await db.memoSessions.get(sessionId);
  if (!session?.speakers) throw new Error("这场还没有说话人信息");
  const speakers = applySpeakerCorrection(session.speakers, meKeys);
  const roleOf = new Map(speakers.map((s) => [s.key, s.role]));
  const utterances = (await db.utterances.where("sessionId").equals(sessionId).toArray()).map((u) => ({ ...u, speaker: roleOf.get(u.speakerKey) ?? "other" }));
  if (!utterances.length) throw new Error("逐字稿已被清理，无法重新判断");
  const windows = splitWindows(sessionId, utterances);
  await db.transaction("rw", [db.utterances, db.memoWindows, db.moments], async () => {
    await db.utterances.bulkPut(utterances);
    await db.memoWindows.where("sessionId").equals(sessionId).delete();
    await db.memoWindows.bulkPut(windows);
    await db.moments.where("sessionId").equals(sessionId).delete();
  });
  await patchSession(sessionId, { speakers, meSource: "user", meUncertain: false, status: "judging", error: undefined });
  return runPipeline(sessionId, opts);
}

/** 过程页：单独重跑一个窗口 */
export async function rejudgeWindow(windowId: string, opts: PipelineOptions = {}): Promise<MemoSession> {
  const window = await db.memoWindows.get(windowId);
  if (!window) throw new Error("窗口不存在");
  await db.memoWindows.put({ ...window, triage: window.triage?.action === "skip" ? undefined : window.triage, judge: window.judge ? { ...window.judge, status: "failed" } : undefined });
  await patchSession(window.sessionId, { status: "judging", error: undefined });
  return runPipeline(window.sessionId, opts);
}

/** 补一段置信度不够时，用户从候选里点一个 */
export async function confirmBackfill(momentId: string, target: { dayKey: string; place?: string }): Promise<void> {
  const moment = await db.moments.get(momentId);
  if (!moment) return;
  await db.moments.put({
    ...moment,
    dayKey: target.dayKey,
    ...(target.place ? { place: { name: target.place, source: "backfill", confidence: "high", locked: true } } : {}),
    backfill: { ...(moment.backfill ?? { confidence: 1 }), targetDayKey: target.dayKey, targetPlace: target.place, confirmedByUser: true, candidates: undefined },
  });
}

/** 手记里改地点：锁定，重新判断不覆盖 */
export async function setMomentPlace(momentId: string, name: string): Promise<void> {
  const moment = await db.moments.get(momentId);
  if (!moment) return;
  await db.moments.put({ ...moment, place: { name, source: "manual", confidence: "high", locked: true } });
}

export function degradedParagraphFor(moment: Moment, timeZone: string) {
  return {
    momentId: moment.id,
    heading: `${clockIn(moment.at, timeZone)} · ${placeLabel(moment.place)}`,
    text: moment.user.editedText ?? degradeFromQuotes(quotesForWriting(moment)),
    verified: false,
    degraded: !moment.user.editedText,
    retries: 0,
    userEdited: Boolean(moment.user.editedText),
  };
}
