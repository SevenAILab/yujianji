// 照片 → 3D 模型（服务端）。和后端文件 app/providers.py、scripts/demo-3d 同一套 Tripo v3 调用：
// 上传照片 → image-to-model（standard 档，约 30 积分）→ 轮询 → 下载原始 GLB（几十 MB）→ 减面 + meshopt + 512 WebP（约 0.5 MB）。
//
// 隐私：遇见集承诺「服务端不保存你的照片和记录」。所以这里只记任务状态（设备 id、任务号、时间），
// 照片不落盘（直接转给 Tripo）；压缩好的模型交给浏览器后存进本机 IndexedDB，服务器上的文件 2 小时后删掉。
//
// 付费请求（创建任务）绝不自动重试；同一设备同一藏品重复提交，复用已有任务，不重复扣费。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.TRIPO_BASE_URL || "https://openapi.tripo3d.ai/v3").replace(/\/$/, "");
const MODEL = "v3.1-20260211";
// 任务记录要跨重启保留（防重复扣费），默认放项目下的 .data/（已 gitignore）
const DIR = process.env.MODEL3D_DIR || path.join(process.cwd(), ".data", "model3d");
const FILE_TTL_MS = 2 * 3600_000;

export type Model3dState = "submitted" | "running" | "processing" | "ready" | "failed";

export interface Model3dJob {
  taskId: string;
  deviceId: string;
  itemId: string;
  state: Model3dState;
  progress: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class Model3dError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export function model3dConfigured(): boolean {
  return Boolean(process.env.TRIPO_API_KEY);
}

async function tripo(pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.TRIPO_API_KEY}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { code?: number; data?: Record<string, unknown>; message?: string } | null;
  if (!response.ok || payload?.code !== 0 || !payload.data) {
    throw new Model3dError("TRIPO_ERROR", `建模服务返回异常（HTTP ${response.status}${payload?.message ? `：${String(payload.message).slice(0, 80)}` : ""}）`);
  }
  return payload.data;
}

async function uploadPhoto(bytes: Uint8Array, mime: string): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart], { type: mime }), mime === "image/png" ? "photo.png" : "photo.jpg");
  // 上传是幂等的，可以重试
  for (let attempt = 0; ; attempt += 1) {
    try {
      const data = await tripo("/files", { method: "POST", body: form, timeoutMs: 90_000 });
      if (typeof data.file_token !== "string") throw new Model3dError("TRIPO_ERROR", "建模服务没返回文件标识");
      return data.file_token;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

// ── 任务记录：每个任务一个 JSON，进程重启不丢 ──
const jobPath = (taskId: string) => path.join(DIR, "jobs", `${taskId}.json`);
const keyPath = (key: string) => path.join(DIR, "keys", `${key}.txt`);
const modelPath = (taskId: string) => path.join(DIR, "models", `${taskId}.glb`);
const TASK_ID = /^[0-9a-f-]{16,64}$/i;

async function writeAtomic(file: string, data: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
}

export async function readJob(taskId: string): Promise<Model3dJob | null> {
  if (!TASK_ID.test(taskId)) return null;
  try {
    return JSON.parse(await readFile(jobPath(taskId), "utf8")) as Model3dJob;
  } catch {
    return null;
  }
}

async function saveJob(job: Model3dJob) {
  await writeAtomic(jobPath(job.taskId), JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
}

/** 提交一张照片建模。同一设备同一藏品只会有一个任务 */
export async function submitPhoto(input: { deviceId: string; itemId: string; bytes: Uint8Array; mime: string }): Promise<Model3dJob> {
  const key = createHash("sha256").update(`${input.deviceId}\n${input.itemId}`).digest("hex").slice(0, 40);
  try {
    const existing = await readJob((await readFile(keyPath(key), "utf8")).trim());
    if (existing && existing.state !== "failed") return existing;
  } catch {
    // 没提交过
  }
  const token = await uploadPhoto(input.bytes, input.mime);
  const data = await tripo("/generation/image-to-model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: token,
      model: MODEL,
      texture: true,
      pbr: true,
      texture_quality: "standard",
      geometry_quality: "standard",
      enable_image_autofix: true,
    }),
    timeoutMs: 60_000,
  });
  if (typeof data.task_id !== "string") throw new Model3dError("TRIPO_ERROR", "建模服务没返回任务号");
  const now = new Date().toISOString();
  const job: Model3dJob = { taskId: data.task_id, deviceId: input.deviceId, itemId: input.itemId, state: "submitted", progress: 0, createdAt: now, updatedAt: now };
  await saveJob(job);
  await writeAtomic(keyPath(key), job.taskId);
  return job;
}

// 同一个任务的下载 + 压缩只跑一次；整台机器同时只压一个（原始件上百万面，吃内存）
const finishing = new Map<string, Promise<void>>();
let queue: Promise<void> = Promise.resolve();

/** 查一次进度；Tripo 完成后在后台下载、压缩，好了就是 ready */
export async function refreshJob(job: Model3dJob): Promise<Model3dJob> {
  if (job.state === "ready" || job.state === "failed" || job.state === "processing") {
    if (job.state === "processing" && !finishing.has(job.taskId) && Date.now() - Date.parse(job.updatedAt) > 10 * 60_000) {
      // 进程重启把后台处理打断了：重新处理
      return refreshJob({ ...job, state: "running" });
    }
    return job;
  }
  const task = await tripo(`/tasks/${job.taskId}`);
  const status = String(task.status ?? "");
  const progress = typeof task.progress === "number" ? task.progress : job.progress;
  if (status === "success") {
    const url = (task.output as { model_url?: string; pbr_model?: string } | undefined)?.model_url ?? (task.output as { pbr_model?: string } | undefined)?.pbr_model;
    if (!url) return failJob(job, "建模完成了，但没拿到模型文件");
    const next: Model3dJob = { ...job, state: "processing", progress: 100 };
    await saveJob(next);
    startFinishing(next, url);
    return next;
  }
  if (["failed", "cancelled", "banned", "expired"].includes(status)) return failJob(job, "这张照片没能建成模型");
  const next: Model3dJob = { ...job, state: status === "queued" ? "submitted" : "running", progress };
  await saveJob(next);
  return next;
}

async function failJob(job: Model3dJob, error: string): Promise<Model3dJob> {
  const next: Model3dJob = { ...job, state: "failed", error };
  await saveJob(next);
  return next;
}

function startFinishing(job: Model3dJob, url: string) {
  if (finishing.has(job.taskId)) return;
  const run = (queue = queue.then(async () => {
    try {
      const raw = await download(url);
      const optimized = await optimizeGlb(raw);
      await writeAtomic(modelPath(job.taskId), optimized);
      await saveJob({ ...job, state: "ready", progress: 100 });
    } catch (error) {
      console.error(JSON.stringify({ event: "model3d_finish_failed", taskId: job.taskId, error: String(error).slice(0, 200) }));
      await saveJob({ ...job, state: "failed", error: "模型下载或压缩失败" });
    } finally {
      finishing.delete(job.taskId);
    }
  }));
  finishing.set(job.taskId, run);
}

async function download(url: string): Promise<Uint8Array> {
  const host = new URL(url).hostname;
  if (!/(^|\.)tripo3d\.(ai|com)$/.test(host)) throw new Error(`不认识的模型地址 ${host}`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8 * 60_000), cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "glTF") throw new Error("不是 GLB");
      return bytes;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
}

/** 原始 GLB → 前端 GLB：减面到约 4%、meshopt 压缩、贴图 512 WebP（和 scripts/demo-3d/optimize.sh 同参数） */
export async function optimizeGlb(raw: Uint8Array): Promise<Uint8Array> {
  const [{ Logger, NodeIO }, { ALL_EXTENSIONS }, functions, { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier }] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
    import("meshoptimizer"),
  ]);
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const document = await io.readBinary(raw);
  document.setLogger(new Logger(Logger.Verbosity.WARN));
  await document.transform(
    functions.dedup(),
    functions.weld(),
    functions.simplify({ simplifier: MeshoptSimplifier, ratio: 0.04, error: 0.01 }),
    functions.prune(),
  );
  try {
    // 贴图压缩靠 sharp；装不上就保留原贴图（体积大一些，但模型照样能用）
    const sharp = (await import("sharp")).default;
    await document.transform(functions.textureCompress({ encoder: sharp, targetFormat: "webp", resize: [512, 512] }));
  } catch (error) {
    console.warn(JSON.stringify({ event: "model3d_texture_skip", error: String(error).slice(0, 120) }));
  }
  await document.transform(functions.reorder({ encoder: MeshoptEncoder }), functions.quantize(), functions.meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  return io.writeBinary(document);
}

export async function readModel(taskId: string): Promise<Uint8Array | null> {
  if (!TASK_ID.test(taskId)) return null;
  try {
    return new Uint8Array(await readFile(modelPath(taskId)));
  } catch {
    return null;
  }
}

/** 模型交给浏览器以后不长期留：超过 2 小时的删掉（任务记录保留，防止重复扣费） */
export async function sweepModels(): Promise<void> {
  const dir = path.join(DIR, "models");
  try {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - (await stat(file)).mtimeMs > FILE_TTL_MS) await rm(file, { force: true });
    }
  } catch {
    // 目录还不存在
  }
}
