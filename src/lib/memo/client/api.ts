"use client";

// 遇见手记接口的前端封装：带设备标识、把错误码转成人话、失败时保留服务端带回的 trace。
import { apiUrl } from "../../app-mode";
import { getDeviceId } from "../../device-id";
import type { JudgeRequest, MatchRequest, ReflectOp, ReflectRequest, WriteRequest } from "../schema";
import type { AgentTrace, DiaryParagraph, SpeakerRole } from "../types";

export class MemoApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: Record<string, unknown>;
  constructor(code: string, status: number, message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "MemoApiError";
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
  get trace(): AgentTrace | undefined {
    return this.payload.trace as AgentTrace | undefined;
  }
}

const MESSAGES: Record<string, string> = {
  DEVICE_REQUIRED: "设备标识丢失了，刷新页面再试一次。",
  RATE_LIMITED: "请求太频繁了，歇一会儿再来。",
  DAILY_BUDGET_EXHAUSTED: "今天的体验额度用完了，明天再来。",
  BUDGET_EXCEEDED: "今天遇见手记的模型费用到上限了。",
  CHUNK_TOO_LARGE: "录音分块太大，服务器拒收了。",
  BAD_UPLOAD_ID: "上传标识不对，重新开始处理这段录音。",
  MISSING_CHUNKS: "有录音分块没传上去，正在补传。",
  NOT_FOUND: "服务器上找不到这次上传（可能已过期），需要重新上传。",
  NOT_ASSEMBLED: "录音还没上传完。",
  FFMPEG_UNAVAILABLE: "服务器还没装 ffmpeg，没法转码。请部署同学执行 apt install ffmpeg。",
  FFMPEG_FAILED: "这个音频文件转码失败，换一个文件试试。",
  UPLOAD_POLICY_FAILED: "上传到语音识别临时存储失败，可以重试。",
  OSS_UPLOAD_FAILED: "上传到语音识别临时存储失败，可以重试。",
  ASR_SUBMIT_FAILED: "提交语音识别失败，可以重试。",
  ASR_SUBMIT_UNKNOWN: "上次提交语音识别时连接中断，不确定是否已提交。重新提交可能重复计费（约 0.013 元/分钟）。",
  ASR_FAILED: "语音识别失败，可以重试或换 paraformer-v2。",
  ASR_RESULT_FETCH_FAILED: "取语音识别结果失败，可以重试。",
  FEISHU_AUTH_REQUIRED: "还没有授权飞书。",
  FEISHU_AUTH_EXPIRED: "飞书授权过期了，请重新授权。",
  FEISHU_FORBIDDEN: "飞书授权的权限不够，请重新授权。",
  FEISHU_NOT_READY: "飞书还在整理这段录音的文字记录，过几分钟再试。",
  FEISHU_NOT_CONFIGURED: "服务器还没配置飞书应用，暂时不能从飞书导入。",
  FEISHU_RATE_LIMITED: "飞书接口限流了，稍后再试。",
  FEISHU_ALREADY_IMPORTED: "这段录音已经导入过了。",
  FEISHU_TIME_REQUIRED: "文字记录里读不到录音时间，请先填开始录音的时间。",
  FEISHU_HANDOFF_MISSING: "授权结果已经领取过或过期了，请重新授权。",
  FEISHU_MEDIA_TOO_LARGE: "这段录音太大，暂时处理不了。",
  FEISHU_REIMPORT: "这段飞书录音没有导入完整：删掉它，再从飞书导入一次。",
  ASR_UNAVAILABLE: "语音转文字服务的额度用完了，这段录音暂时转不了文字（录音还在手机里）。录音豆的录音可以改用「从飞书导入」，飞书已经转好了文字。",
  AGENT_BUDGET_EXCEEDED: "Agent 超过了步数、工具次数或时间上限，这一段可以单独重跑。",
  INVALID_MODEL_OUTPUT: "模型交回的结果格式不对，重试一次通常就好。",
  MODEL_ERROR: "模型服务暂时不可用，请重试。",
  MODEL_RATE_LIMITED: "模型服务限流了，过一会儿再试。",
  MODEL_UNAVAILABLE: "判断和写作用的模型服务拒绝调用（额度用完或密钥失效），录音已保存，换模型服务后可以重跑。",
  INVALID_REQUEST: "请求内容格式不对。",
  REQUEST_TOO_LARGE: "请求内容太长。",
};

export function describeMemoError(error: unknown): string {
  if (error instanceof MemoApiError) return MESSAGES[error.code] ?? error.message;
  if (error instanceof TypeError) return "网络没连上，检查一下网络再试。";
  return error instanceof Error && error.message ? error.message : "出了点问题，请重试。";
}

async function call<T>(method: "GET" | "POST", path: string, init: { json?: unknown; body?: Blob; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const deviceId = await getDeviceId();
  const response = await fetch(apiUrl(path), {
    method,
    cache: "no-store",
    headers: {
      "x-device-id": deviceId,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    signal: init.signal,
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`;
    throw new MemoApiError(code, response.status, typeof payload?.error === "string" ? payload.error : "请求失败", payload ?? {});
  }
  return (payload ?? {}) as T;
}

export interface PrepareStatusResponse {
  status: "running" | "done" | "failed";
  durationSec?: number;
  channelsIn?: number;
  parts?: { partIndex: number; ossUrl: string; offsetMs: number; durationMs: number }[];
  code?: string;
  error?: string;
}

export interface TranscribeStatusResponse {
  status: "running" | "succeeded" | "failed";
  sentences?: { partIndex: number; beginMs: number; endMs: number; speakerId: string; speakerKey: string; text: string }[];
  speakers?: { key: string; meanDb: number | null; talkMs: number }[];
  speakersDegraded?: boolean;
  /** 声纹注册命中时，每个分段里"我"的 speakerKey */
  meSpeakerKeys?: string[];
  asrSeconds?: number;
  asrModel?: string;
  asrCostYuan?: number;
  code?: string;
  error?: string;
}

export interface JudgeResponse {
  moments: {
    sourceUtteranceIds: string[];
    decision: "keep" | "fold" | "drop";
    category: string;
    salience: number;
    trigger: string;
    why: string;
    othersParaphrase?: string;
    facts?: { entity: string; fact: string }[];
    backfillTarget?: { dayKey: string; place?: string; confidence: number };
    backfillCandidates?: { dayKey: string; place?: string; momentId?: string; label: string }[];
    /** G10 校验过的配图（遇见集藏品 id）；没配到就没有这个字段 */
    photoId?: string;
    myQuotes: string[];
    uncertainQuotes: string[];
    speakerUncertain: boolean;
    needsPlacePick: boolean;
    guardNotes: string[];
  }[];
  sessionNotes: string;
  trace: AgentTrace;
}

export const memoApi = {
  uploadChunk(uploadId: string, index: number, total: number, blob: Blob, signal?: AbortSignal) {
    return call<{ received: number; duplicate: boolean }>("POST", "/api/memo/upload/chunk", {
      body: blob,
      headers: { "x-upload-id": uploadId, "x-chunk-index": String(index), "x-chunk-total": String(total), "content-type": "application/octet-stream" },
      signal,
    });
  },
  uploadStatus(uploadId: string) {
    return call<{ phase: string; totalChunks: number; received: number[] }>("GET", `/api/memo/upload/status?uploadId=${encodeURIComponent(uploadId)}`);
  },
  /** 声纹注册音频：必须在 finishUpload 之前传，服务端会把它拼到每个 ASR 分段前面 */
  uploadEnroll(uploadId: string, enrollMs: number, blob: Blob) {
    return call<{ ok: true; enrollMs: number }>("POST", "/api/memo/upload/enroll", {
      body: blob,
      headers: { "x-upload-id": uploadId, "x-enroll-ms": String(enrollMs), "content-type": "application/octet-stream" },
    });
  },
  finishUpload(uploadId: string, totalChunks: number, mime: string, enrollMs?: number) {
    return call<{ sizeBytes: number }>("POST", "/api/memo/upload/finish", {
      json: { uploadId, totalChunks, mime, ...(enrollMs ? { enrollMs } : {}) },
    });
  },
  prepare(uploadId: string) {
    return call<{ status: string }>("POST", "/api/memo/prepare", { json: { uploadId } });
  },
  prepareStatus(uploadId: string) {
    return call<PrepareStatusResponse>("GET", `/api/memo/prepare/status?uploadId=${encodeURIComponent(uploadId)}`);
  },
  transcribe(uploadId: string, force = false) {
    return call<{ taskIds: string[]; reused: boolean }>("POST", "/api/memo/transcribe", { json: { uploadId, force } });
  },
  transcribeStatus(uploadId: string, taskIds: string[], offsets: number[]) {
    const q = new URLSearchParams({ uploadId, taskIds: taskIds.join(","), offsets: offsets.join(",") });
    return call<TranscribeStatusResponse>("GET", `/api/memo/transcribe/status?${q.toString()}`);
  },
  triage(body: { runId: string; window: { id: string; utterances: { id: string; offsetMs: number; speaker: SpeakerRole; text: string }[] } }) {
    return call<{ action: "judge" | "skip"; reason: string; trace: AgentTrace }>("POST", "/api/memo/triage", { json: body });
  },
  judge(body: JudgeRequest) {
    return call<JudgeResponse>("POST", "/api/memo/judge", { json: body });
  },
  match(body: MatchRequest) {
    return call<{ matches: { momentId: string; photoId: string; reason: string }[]; trace: AgentTrace }>("POST", "/api/memo/match", { json: body });
  },
  // ── 飞书妙记导入（外部设备接入工单 v2 Gate 1）：令牌只放请求头，不进 URL ──
  feishuClaim() {
    return call<{ tokens: { accessToken: string; refreshToken?: string; expiresAt: number; refreshExpiresAt?: number }; names?: string[] }>("POST", "/api/memo/feishu/claim", { json: {} });
  },
  feishuRefresh(refreshToken: string) {
    return call<{ tokens: { accessToken: string; refreshToken?: string; expiresAt: number; refreshExpiresAt?: number } }>("POST", "/api/memo/feishu/refresh", { json: { refreshToken } });
  },
  feishuMinutes(accessToken: string, range: { startIso: string; endIso: string }) {
    return call<{ items: { token: string; title: string; description: string }[]; hasMore: boolean }>("POST", "/api/memo/feishu/minutes", { json: range, headers: { authorization: `Bearer ${accessToken}` } });
  },
  feishuPreview(accessToken: string, token: string) {
    return call<import("./feishu").FeishuPreview>("POST", "/api/memo/feishu/preview", { json: { token }, headers: { authorization: `Bearer ${accessToken}` } });
  },
  feishuTranscript(accessToken: string, token: string, ownerNames: string[]) {
    return call<import("./feishu").FeishuTranscriptResponse>("POST", "/api/memo/feishu/transcript", { json: { token, ownerNames: ownerNames.slice(0, 2) }, headers: { authorization: `Bearer ${accessToken}` } });
  },
  write(body: WriteRequest) {
    return call<{ title: string; quotes: { momentId: string; text: string }[]; paragraphs: DiaryParagraph[]; trace: AgentTrace }>("POST", "/api/memo/write", { json: body });
  },
  reflect(body: ReflectRequest) {
    return call<{ ops: ReflectOp[]; rejected: { op: string; text: string; reason: string }[]; summary: string; trace: AgentTrace }>("POST", "/api/memo/reflect", { json: body });
  },
};
