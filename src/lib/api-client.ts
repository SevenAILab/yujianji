"use client";

import { apiUrl } from "./app-mode";
import { getDeviceId } from "./device-id";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** 服务端错误码 → 用户能看懂的话。未知码保持原样，不吞掉。 */
const MESSAGES: Record<string, string> = {
  RATE_LIMITED: "你这一小时的体验次数用完了，歇一会儿再来。",
  DAILY_BUDGET_EXHAUSTED: "今天全站的体验额度用完了，明天再来。",
  DEVICE_REQUIRED: "设备标识丢失了，刷新页面再试一次。",
  IMAGE_TOO_LARGE: "这张图太大了，换一张或者重新拍一张。",
  MODEL_TIMEOUT: "模型这次想太久了，再试一次通常就好。",
  MODEL_ERROR: "模型服务暂时不可用，请重试。",
  INVALID_REQUEST: "这次的内容格式不对，重新试一次。",
};

export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof TypeError) {
    // fetch 抛 TypeError 基本就是断网或被拦截。
    return "网络没连上，检查一下网络再试。";
  }
  return error instanceof Error && error.message ? error.message : "出了点问题，请重试。";
}

/**
 * 所有接口的统一入口：补 API base（原生壳要打绝对地址）、带设备标识。
 * 返回原始 Response —— 各页面已有的错误处理逻辑保持不变，不在这里吞错。
 */
export async function apiFetch(
  path: string,
  body: unknown,
  init?: { signal?: AbortSignal | null },
): Promise<Response> {
  const deviceId = await getDeviceId();
  return fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": deviceId,
    },
    body: JSON.stringify(body),
    signal: init?.signal ?? null,
  });
}

/**
 * 需要统一错误码映射时用这个：补 API base、带设备标识、把错误码转成人话。
 * 不做自动重试 —— 重试是每个页面自己的产品决策（有的要提示用户，有的要静默）。
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const deviceId = await getDeviceId();
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": deviceId,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { code?: string; error?: string }
    | null;

  if (!response.ok) {
    const code = payload?.code ?? "MODEL_ERROR";
    throw new ApiError(code, response.status, payload?.error ?? "请求失败");
  }
  return payload as T;
}
