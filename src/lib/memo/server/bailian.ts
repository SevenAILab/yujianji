// 百炼：临时存储 + 录音文件识别（spec §2.3，S0 第 5 项 9/16 实测通过：dashscope.aliyuncs.com 可用，33 秒录音全链路 3.7 秒）。
import { readFile } from "node:fs/promises";
import path from "node:path";

export type BailianErrorCode =
  | "UPLOAD_POLICY_FAILED"
  | "OSS_UPLOAD_FAILED"
  | "ASR_SUBMIT_FAILED"
  | "ASR_QUERY_FAILED"
  | "ASR_FAILED"
  | "ASR_RESULT_FETCH_FAILED";

export class BailianError extends Error {
  readonly code: BailianErrorCode;
  /** 请求发出去但没拿到响应（超时、断网）：对方可能已经创建了任务 */
  readonly uncertain: boolean;
  constructor(code: BailianErrorCode, message: string, uncertain = false) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function asrModel(): string {
  return process.env.MEMO_ASR_MODEL?.trim() || "fun-asr";
}

export function asrBaseUrl(): string {
  return (process.env.MEMO_ASR_BASE_URL?.trim() || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
}

function authHeader(): Record<string, string> {
  // 语音识别只能走百炼：站点主模型可能是别家（国内站是 Agnes），所以优先用 MEMO_API_KEY
  const key = process.env.MEMO_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY;
  if (!key) throw new BailianError("ASR_SUBMIT_FAILED", "缺少 MEMO_API_KEY（或 DASHSCOPE_API_KEY）");
  return { Authorization: `Bearer ${key}` };
}

async function withRetry<T>(times: number, fn: (attempt: number) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= times; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      if (attempt < times) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw last;
}

const MIME_BY_EXT: Record<string, string> = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac" };

/** 上传到百炼临时存储，返回 oss:// 地址（48 小时有效，由平台自动清除，我们无法提前删除）。失败重试 3 次（spec §7）。 */
export async function uploadToTempStorage(file: string, model = asrModel()): Promise<string> {
  const policy = await withRetry(3, async () => {
    const res = await fetch(`https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
      headers: authHeader(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { data?: Record<string, string> } | null;
    if (!res.ok || !json?.data?.upload_host) throw new BailianError("UPLOAD_POLICY_FAILED", `getPolicy HTTP ${res.status}`);
    return json.data;
  }).catch((error) => {
    throw error instanceof BailianError ? error : new BailianError("UPLOAD_POLICY_FAILED", String((error as Error)?.message ?? error));
  });

  const bytes = await readFile(file);
  const key = `${policy.upload_dir}/${Date.now()}-${path.basename(file)}`;
  await withRetry(3, async () => {
    const form = new FormData();
    form.append("OSSAccessKeyId", policy.oss_access_key_id);
    form.append("Signature", policy.signature);
    form.append("policy", policy.policy);
    form.append("x-oss-object-acl", policy.x_oss_object_acl);
    form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
    form.append("key", key);
    form.append("success_action_status", "200");
    form.append("file", new Blob([bytes], { type: MIME_BY_EXT[path.extname(file)] ?? "application/octet-stream" }), path.basename(file));
    const res = await fetch(policy.upload_host, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new BailianError("OSS_UPLOAD_FAILED", `OSS HTTP ${res.status}`);
  }).catch((error) => {
    throw error instanceof BailianError ? error : new BailianError("OSS_UPLOAD_FAILED", String((error as Error)?.message ?? error));
  });
  return `oss://${key}`;
}

export async function submitTranscription(ossUrl: string, model = asrModel()): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${asrBaseUrl()}/api/v1/services/audio/asr/transcription`, {
      method: "POST",
      headers: {
        ...authHeader(),
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
        "X-DashScope-OssResourceResolve": "enable",
      },
      body: JSON.stringify({
        model,
        input: { file_urls: [ossUrl] },
        parameters: { channel_id: [0], diarization_enabled: true, language_hints: ["zh", "en"] },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new BailianError("ASR_SUBMIT_FAILED", String((error as Error)?.message ?? error), true);
  }
  const json = (await res.json().catch(() => null)) as { output?: { task_id?: string }; code?: string; message?: string } | null;
  if (!res.ok || !json?.output?.task_id) {
    throw new BailianError("ASR_SUBMIT_FAILED", `HTTP ${res.status} ${json?.code ?? ""}`.trim());
  }
  return json.output.task_id;
}

export interface TaskStatus {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  transcriptionUrl?: string;
  /** 静音等"成功但没有有效片段"的情况 */
  empty?: boolean;
  errorCode?: string;
}

export async function queryTask(taskId: string): Promise<TaskStatus> {
  let res: Response;
  try {
    res = await fetch(`${asrBaseUrl()}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: authHeader(), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new BailianError("ASR_QUERY_FAILED", String((error as Error)?.message ?? error));
  }
  const json = (await res.json().catch(() => null)) as {
    output?: { task_status?: string; results?: { subtask_status?: string; transcription_url?: string; code?: string }[]; code?: string };
  } | null;
  if (!res.ok || !json?.output) throw new BailianError("ASR_QUERY_FAILED", `HTTP ${res.status}`);
  const taskStatus = (json.output.task_status ?? "UNKNOWN") as TaskStatus["status"];
  const sub = json.output.results?.[0];
  if (taskStatus === "SUCCEEDED" && sub?.subtask_status === "FAILED") {
    if (sub.code === "SUCCESS_WITH_NO_VALID_FRAGMENT") return { status: "SUCCEEDED", empty: true };
    return { status: "FAILED", errorCode: sub.code ?? "SUBTASK_FAILED" };
  }
  if (taskStatus === "FAILED") return { status: "FAILED", errorCode: json.output.code ?? sub?.code ?? "TASK_FAILED" };
  return { status: taskStatus, transcriptionUrl: sub?.transcription_url };
}

export interface AsrSentence {
  beginMs: number;
  endMs: number;
  text: string;
  speakerId: string;
}

export async function fetchTranscription(url: string): Promise<{ sentences: AsrSentence[]; durationMs: number | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      properties?: { original_duration_in_milliseconds?: number };
      transcripts?: { sentences?: { begin_time: number; end_time: number; text: string; speaker_id?: number | string }[] }[];
    };
    const sentences = (json.transcripts ?? []).flatMap((t) => t.sentences ?? []).map((s) => ({
      beginMs: Math.max(0, Math.round(s.begin_time)),
      endMs: Math.max(0, Math.round(s.end_time)),
      text: String(s.text ?? "").trim(),
      speakerId: String(s.speaker_id ?? "0"),
    }));
    return { sentences: sentences.filter((s) => s.text), durationMs: json.properties?.original_duration_in_milliseconds ?? null };
  } catch (error) {
    throw new BailianError("ASR_RESULT_FETCH_FAILED", String((error as Error)?.message ?? error));
  }
}
