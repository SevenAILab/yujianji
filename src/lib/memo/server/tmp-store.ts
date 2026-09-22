// 服务端临时目录 MEMO_TMP_DIR/<uploadId>/：分块、合并后的原始音频、转码文件、state.json。
// 单进程部署（spec §2.2）才成立。state.json 只存任务号、分段、状态，不存任何转写文字。
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const UPLOAD_ID_PATTERN = /^up_[A-Za-z0-9_-]{8,40}$/;
/** 失败或中断的上传最多保留这么久，供重试；之后请求时顺手清掉（不上 cron） */
export const STALE_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type JobPhase =
  | "uploading"
  | "assembled"
  | "preparing"
  | "prepared"
  | "submitting"
  | "submitted"
  | "failed";

export interface UploadPart {
  partIndex: number;
  ossUrl: string;
  offsetMs: number;
  durationMs: number;
}

export interface UploadState {
  uploadId: string;
  deviceId: string;
  phase: JobPhase;
  totalChunks: number;
  mime?: string;
  sizeBytes?: number;
  durationSec?: number;
  channelsIn?: number;
  parts?: UploadPart[];
  /** 与 parts 按下标对齐；空串 = 该段还没提交 */
  taskIds?: string[];
  /** 声纹注册音频的毫秒数。>0 表示每个 ASR 分段前都拼了这段，识别后要剥掉并回正时间轴 */
  enrollMs?: number;
  /** 失败时停在哪一步，重试从这里继续 */
  failedAt?: "prepare" | "submit" | "asr";
  error?: { code: string; message: string };
  timings?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export function tmpRoot(): string {
  return process.env.MEMO_TMP_DIR?.trim() || path.join(os.tmpdir(), "yujianji-memo");
}

export function isValidUploadId(uploadId: string | null | undefined): uploadId is string {
  return typeof uploadId === "string" && UPLOAD_ID_PATTERN.test(uploadId);
}

export function uploadDir(uploadId: string): string {
  if (!isValidUploadId(uploadId)) throw new Error("BAD_UPLOAD_ID");
  return path.join(tmpRoot(), uploadId);
}

export function chunksDir(uploadId: string): string {
  return path.join(uploadDir(uploadId), "chunks");
}

export function chunkPath(uploadId: string, index: number): string {
  return path.join(chunksDir(uploadId), `${String(index).padStart(5, "0")}.part`);
}

/** 声纹注册音频：用户首次录的那 8 秒，原始容器 */
export function enrollSourcePath(uploadId: string): string {
  return path.join(uploadDir(uploadId), "enroll.src");
}

/** 注册音频转码后的 16k 单声道，和正文分段参数一致，才能 -c copy 拼接 */
export function enroll16kPath(uploadId: string): string {
  return path.join(uploadDir(uploadId), "enroll16k.m4a");
}

export function statePath(uploadId: string): string {
  return path.join(uploadDir(uploadId), "state.json");
}

export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function readState(uploadId: string): Promise<UploadState | null> {
  try {
    return JSON.parse(await readFile(statePath(uploadId), "utf8")) as UploadState;
  } catch {
    return null;
  }
}

export async function writeState(state: UploadState): Promise<UploadState> {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await atomicWrite(statePath(state.uploadId), JSON.stringify(next));
  return next;
}

export async function patchState(uploadId: string, patch: Partial<UploadState>): Promise<UploadState> {
  const current = await readState(uploadId);
  if (!current) throw new Error("NOT_FOUND");
  return writeState({ ...current, ...patch });
}

export async function receivedChunks(uploadId: string): Promise<number[]> {
  try {
    const names = await readdir(chunksDir(uploadId));
    return names
      .filter((n) => /^\d{5}\.part$/.test(n))
      .map((n) => Number(n.slice(0, 5)))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function removeUpload(uploadId: string): Promise<void> {
  await rm(uploadDir(uploadId), { recursive: true, force: true });
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

let lastSweep = 0;

/** 删掉超过 2 小时没更新的上传目录。节流：5 分钟最多扫一次。 */
export async function sweepStale(now = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return 0;
  lastSweep = now;
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(tmpRoot());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!isValidUploadId(name)) continue;
    const state = await readState(name);
    let updated = state ? new Date(state.updatedAt).getTime() : NaN;
    if (!Number.isFinite(updated)) {
      try {
        updated = (await stat(uploadDir(name))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - updated > STALE_MS) {
      await removeUpload(name);
      removed += 1;
    }
  }
  if (removed) console.info(JSON.stringify({ event: "memo_tmp_swept", removed }));
  return removed;
}
