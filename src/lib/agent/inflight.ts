// 同一个 runId 的重复请求（双击、刷新后立刻重发）合并到同一次模型调用，不重复花钱。
// 只在请求进行中合并；完成后立即释放，服务端不保留任何结果（D5：服务端不存用户数据）。
import { createHash } from "node:crypto";

const inflight = new Map<string, Promise<unknown>>();

export function inflightKey(scope: string, runId: string, body: unknown): string {
  const digest = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return `${scope}:${runId}:${digest}`;
}

export async function dedupeInflight<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; joined: boolean }> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return { value: await existing, joined: true };
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return { value: await promise, joined: false };
}

export function inflightCount(): number {
  return inflight.size;
}
