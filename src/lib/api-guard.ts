import { NextResponse } from "next/server";
import { get, incr, KV_BACKEND, KvUnavailableError } from "./kv";

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,40}$/;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const LIMITS = {
  deviceHourly: () => readNumber("DEVICE_HOURLY_LIMIT", 20),
  deviceDaily: () => readNumber("DEVICE_DAILY_LIMIT", 60),
  globalHourly: () => readNumber("GLOBAL_HOURLY_LIMIT", 300),
  dailyBudget: () => readNumber("DAILY_CALL_BUDGET", 500),
};

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function hourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

export type GuardOk = { ok: true; deviceId: string };
export type GuardFail = { ok: false; response: NextResponse };
export type GuardResult = GuardOk | GuardFail;

/**
 * 花钱接口的统一闸门。顺序是有意的：先验身份，再看全站预算，最后看单设备配额 ——
 * 全站预算烧完时，所有人得到的是同一句话，而不是有人 429 有人 503。
 *
 * KV 挂掉时一律拒绝（503）。宁可全站停 AI，也不要在限流失效的情况下继续烧钱。
 */
export async function guard(request: Request): Promise<GuardResult> {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return {
      ok: false,
      response: errorResponse(401, "DEVICE_REQUIRED", "缺少有效的设备标识"),
    };
  }

  const day = dayKey();
  const hour = hourKey();

  try {
    const globalDaily = await incr(`budget:${day}`, 90_000);
    if (globalDaily > LIMITS.dailyBudget()) {
      console.error(
        JSON.stringify({ event: "daily_budget_exhausted", day, count: globalDaily }),
      );
      return {
        ok: false,
        response: errorResponse(
          503,
          "DAILY_BUDGET_EXHAUSTED",
          "今天的体验额度已经用完了，明天再来。",
        ),
      };
    }

    const globalHourly = await incr(`global:${hour}`, 3_700);
    if (globalHourly > LIMITS.globalHourly()) {
      return {
        ok: false,
        response: errorResponse(429, "RATE_LIMITED", "现在用的人有点多，过一会儿再试。"),
      };
    }

    const perHour = await incr(`dev:${deviceId}:${hour}`, 3_700);
    const perDay = await incr(`dev:${deviceId}:${day}`, 90_000);
    if (perHour > LIMITS.deviceHourly() || perDay > LIMITS.deviceDaily()) {
      return {
        ok: false,
        response: errorResponse(
          429,
          "RATE_LIMITED",
          "你这段时间的体验次数用完了，歇一会儿再来。",
        ),
      };
    }

    // 异常模式：单设备逼近上限时留一条告警，供后续接入监控。
    if (perHour === LIMITS.deviceHourly()) {
      console.warn(JSON.stringify({ event: "device_quota_reached", deviceId, hour }));
    }
    const budgetRatio = globalDaily / LIMITS.dailyBudget();
    if (budgetRatio >= 0.8 && budgetRatio - 1 / LIMITS.dailyBudget() < 0.8) {
      console.warn(JSON.stringify({ event: "daily_budget_80pct", day, count: globalDaily }));
    }

    return { ok: true, deviceId };
  } catch (error) {
    if (error instanceof KvUnavailableError) {
      console.error(JSON.stringify({ event: "kv_unavailable", message: error.message }));
      return {
        ok: false,
        response: errorResponse(
          503,
          "MODEL_ERROR",
          "服务正在恢复中，请稍后再试。",
        ),
      };
    }
    throw error;
  }
}

/** 健康检查用：当前已用额度。读不到返回 null，不编数字。 */
export async function readTodayUsage(): Promise<number | null> {
  try {
    return await get(`budget:${dayKey()}`);
  } catch {
    return null;
  }
}

export { KV_BACKEND };
