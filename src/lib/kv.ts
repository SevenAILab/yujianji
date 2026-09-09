/**
 * 极简计数器存储。有 Upstash 凭据就走 Redis（跨实例真限流），
 * 没有就退回单实例内存（比没有强，但 Vercel 多实例下不是全局限流）。
 *
 * 退回内存时会在启动日志里明确说一次，不许静默假装限流生效。
 */

type MemoryEntry = { value: number; expiresAt: number };

const memory = new Map<string, MemoryEntry>();
let warnedAboutMemory = false;

const REST_URL = process.env.UPSTASH_REDIS_REST_URL ?? "";
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

export const KV_BACKEND: "redis" | "memory" = REST_URL && REST_TOKEN ? "redis" : "memory";

function sweepMemory(now: number): void {
  if (memory.size < 5_000) return;
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}

function memoryIncr(key: string, ttlSeconds: number): number {
  const now = Date.now();
  sweepMemory(now);
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= now) {
    memory.set(key, { value: 1, expiresAt: now + ttlSeconds * 1_000 });
    return 1;
  }
  entry.value += 1;
  return entry.value;
}

function memoryGet(key: string): number {
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return entry.value;
}

async function redisPipeline(commands: string[][]): Promise<unknown[]> {
  const response = await fetch(`${REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${REST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
    // 限流查询不该拖垮主请求。
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`redis http ${response.status}`);
  const parsed = (await response.json()) as Array<{ result?: unknown; error?: string }>;
  const failed = parsed.find((row) => row.error);
  if (failed) throw new Error(`redis error ${failed.error}`);
  return parsed.map((row) => row.result);
}

export class KvUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "kv unavailable");
    this.name = "KvUnavailableError";
  }
}

/** 自增并返回新值，首次写入时设置 TTL。 */
export async function incr(key: string, ttlSeconds: number): Promise<number> {
  if (KV_BACKEND === "memory") {
    if (!warnedAboutMemory) {
      warnedAboutMemory = true;
      console.warn(
        JSON.stringify({
          event: "kv_memory_fallback",
          detail: "未配置 UPSTASH_REDIS_REST_URL/TOKEN，限流仅在单实例内生效",
        }),
      );
    }
    return memoryIncr(key, ttlSeconds);
  }
  try {
    const [value] = (await redisPipeline([
      ["INCR", key],
      ["EXPIRE", key, String(ttlSeconds), "NX"],
    ])) as [number];
    return Number(value);
  } catch (error) {
    throw new KvUnavailableError(error);
  }
}

export async function get(key: string): Promise<number> {
  if (KV_BACKEND === "memory") return memoryGet(key);
  try {
    const [value] = (await redisPipeline([["GET", key]])) as [string | null];
    return value ? Number(value) : 0;
  } catch (error) {
    throw new KvUnavailableError(error);
  }
}

/** 健康检查用：确认后端真的能读写。内存后端永远返回 true。 */
export async function kvHealthy(): Promise<boolean> {
  if (KV_BACKEND === "memory") return true;
  try {
    await redisPipeline([["PING"]]);
    return true;
  } catch {
    return false;
  }
}
