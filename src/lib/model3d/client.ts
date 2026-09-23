"use client";

// 照片 → 3D 模型（浏览器端）：提交 → 轮询 → 把压缩好的 GLB 存进本机 IndexedDB。
// 自动提交只针对「刚拍的、能单独建模的初见」：风景、天空不建模；示例不建模（自带模型）；
// 老照片不自动补（避免一次花一大笔），需要时在精神图景里手动点「让它们成形」。
import { apiFetch } from "../api-client";
import { LOCAL_ONLY } from "../app-mode";
import { db, type Model3dRow } from "../db";
import type { Item } from "../types";

const OBJECT_CATEGORIES = new Set<Item["category"]>(["animal", "plant", "mineral", "food", "artifact", "other"]);
const AUTO_WINDOW_MS = 48 * 3600_000;
const PENDING: Model3dRow["state"][] = ["submitted", "running", "processing"];

type Candidate = Pick<Item, "id" | "photo" | "category" | "isSeed" | "ai" | "createdAt" | "mediaKind">;

/** 这件藏品值不值得建模：自己拍的初见、有主体、是普通照片 */
export function modelable(item: Candidate): boolean {
  return !item.isSeed && item.ai?.verdict === "first" && OBJECT_CATEGORIES.has(item.category) && item.mediaKind !== "panorama" && /^data:image\//.test(item.photo);
}

export async function requestModel(item: Candidate): Promise<Model3dRow> {
  const response = await apiFetch("/api/model3d/jobs", { image: item.photo, itemId: item.id });
  const payload = (await response.json().catch(() => null)) as { taskId?: string; error?: string } | null;
  if (!response.ok || !payload?.taskId) throw new Error(payload?.error ?? "建模服务暂时不可用");
  const now = new Date().toISOString();
  const row: Model3dRow = { itemId: item.id, taskId: payload.taskId, state: "submitted", progress: 0, createdAt: now, updatedAt: now };
  await db.models3d.put(row);
  return row;
}

/** 查一轮进度，好了的把模型取回来。返回还在等的数量 */
export async function syncModelJobs(): Promise<number> {
  const pending = await db.models3d.where("state").anyOf(PENDING).toArray();
  if (!pending.length) return 0;
  const response = await apiFetch("/api/model3d/status", { taskIds: pending.map((row) => row.taskId) });
  if (!response.ok) return pending.length;
  const { jobs } = (await response.json()) as { jobs: { taskId: string; state: Model3dRow["state"]; progress?: number; error?: string }[] };
  let waiting = 0;
  for (const job of jobs) {
    const row = pending.find((candidate) => candidate.taskId === job.taskId);
    if (!row) continue;
    if (job.state === "ready") {
      const model = await apiFetch("/api/model3d/model", { taskId: job.taskId });
      if (model.ok) {
        const glb = await model.arrayBuffer();
        await db.models3d.put({ ...row, state: "ready", progress: 100, glb, updatedAt: new Date().toISOString() });
        continue;
      }
      if (model.status === 410) {
        await db.models3d.put({ ...row, state: "failed", error: "模型文件已过期，可以重新生成", updatedAt: new Date().toISOString() });
        continue;
      }
    }
    if (job.state === "failed") {
      await db.models3d.put({ ...row, state: "failed", error: job.error, updatedAt: new Date().toISOString() });
      continue;
    }
    waiting += 1;
    if (job.state !== row.state || job.progress !== row.progress) {
      await db.models3d.put({ ...row, state: job.state, progress: job.progress ?? row.progress, updatedAt: new Date().toISOString() });
    }
  }
  return waiting;
}

// 提交失败（没开通、额度用完、断网）后，自动提交先歇 10 分钟，别每 20 秒撞一次
let autoPausedUntil = 0;

/** 给还没模型的藏品提交建模。auto=true 只挑最近 48 小时拍的；每轮最多 limit 件 */
export async function submitMissing(options: { auto: boolean; limit: number }): Promise<number> {
  if (LOCAL_ONLY || (options.auto && Date.now() < autoPausedUntil)) return 0;
  const since = new Date(Date.now() - AUTO_WINDOW_MS).toISOString();
  const items = options.auto ? await db.items.where("date").above(since).toArray() : await db.items.toArray();
  const taken = new Set((await db.models3d.toCollection().primaryKeys()).map(String));
  const candidates = items.filter((item) => modelable(item) && !taken.has(item.id)).slice(0, options.limit);
  let submitted = 0;
  for (const item of candidates) {
    try {
      await requestModel(item);
      submitted += 1;
    } catch (error) {
      autoPausedUntil = Date.now() + 10 * 60_000;
      if (!options.auto) throw error; // 手动触发要把原因告诉用户
      break; // 额度用完或服务不可用：这一轮停下，过一会儿再试
    }
  }
  return submitted;
}
