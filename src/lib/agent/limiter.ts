// 模型调用排队（外部设备接入工单 v2 Gate 0）：智谱免费模型并发 2 就会 429。
// 限流是按 API key 算的，不是按设备，所以这里是进程级的全局信号量。
// MEMO_MODEL_CONCURRENCY 不配或 ≤ 0 = 不限（千问的默认行为不变）。
import { AgentError } from "./errors";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
const queue: Waiter[] = [];

export function modelConcurrency(): number {
  const raw = Number(process.env.MEMO_MODEL_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 排队最长等多久；超过就按限流失败，让调用方走它自己的失败出口 */
export function maxQueueWaitMs(): number {
  const raw = Number(process.env.MEMO_MODEL_QUEUE_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

function releaser(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      active += 1;
      next.resolve(releaser());
    }
  };
}

/** 拿一个模型调用名额。返回的函数必须调用一次（finally 里），重复调用无副作用。 */
export function acquireModelSlot(limit = modelConcurrency(), waitMs = maxQueueWaitMs()): Promise<() => void> {
  if (limit <= 0) return Promise.resolve(() => undefined);
  if (active < limit) {
    active += 1;
    return Promise.resolve(releaser());
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(new AgentError("MODEL_RATE_LIMITED", `模型调用排队超过 ${Math.round(waitMs / 1000)} 秒`));
      }, waitMs),
    };
    queue.push(waiter);
  });
}

export async function withModelSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireModelSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 测试用 */
export function limiterState(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
