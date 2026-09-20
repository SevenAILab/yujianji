// 遇见手记接口的公共处理：设备校验与限流、请求体、错误响应。
//
// 与拍照链路的 guard() 分开计数：一场 10 分钟录音要 3 个分块 + 几十次轮询 + 每个窗口一次粗筛和判断，
// 共用 DEVICE_HOURLY_LIMIT=20 会被一场录音用完。这里：
// - light（分块、轮询、查状态）：只校验设备 + 宽松的每小时次数，不占模型额度
// - spend（识别提交、粗筛、判断、写作、反思）：独立的每设备每小时次数 + 全站每日次数；真正的费用闸门是 runAgent 里的元预算
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentError, toAgentError } from "../../agent/errors";
import { incr, KvUnavailableError } from "../../kv";
import { JobError } from "./jobs";

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,40}$/;

function readNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function jsonError(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status });
}

export type MemoGuardResult = { ok: true; deviceId: string } | { ok: false; response: NextResponse };

export async function memoGuard(request: Request, kind: "spend" | "light"): Promise<MemoGuardResult> {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, response: jsonError(401, "DEVICE_REQUIRED", "缺少有效的设备标识") };
  }
  const now = new Date().toISOString();
  const hour = now.slice(0, 13);
  const day = now.slice(0, 10);
  try {
    if (kind === "spend") {
      const global = await incr(`memo:spend:${day}`, 90_000);
      if (global > readNumber("MEMO_DAILY_CALL_BUDGET", 3_000)) {
        return { ok: false, response: jsonError(503, "DAILY_BUDGET_EXHAUSTED", "今天遇见手记的体验额度用完了，明天再来。") };
      }
      const perHour = await incr(`memo:spend:${deviceId}:${hour}`, 3_700);
      if (perHour > readNumber("MEMO_DEVICE_HOURLY_LIMIT", 150)) {
        return { ok: false, response: jsonError(429, "RATE_LIMITED", "这一小时处理的录音太多了，歇一会儿再来。") };
      }
    } else {
      const perHour = await incr(`memo:light:${deviceId}:${hour}`, 3_700);
      if (perHour > readNumber("MEMO_LIGHT_HOURLY_LIMIT", 3_000)) {
        return { ok: false, response: jsonError(429, "RATE_LIMITED", "请求太频繁，歇一会儿再来。") };
      }
    }
  } catch (error) {
    if (error instanceof KvUnavailableError) {
      return { ok: false, response: jsonError(503, "MODEL_ERROR", "服务正在恢复中，请稍后再试。") };
    }
    throw error;
  }
  return { ok: true, deviceId };
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      return { ok: false, response: jsonError(413, "REQUEST_TOO_LARGE", "请求内容太长") };
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_REQUEST", "请求格式不正确") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, response: jsonError(400, "INVALID_REQUEST", `请求字段不正确：${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim()) };
  }
  return { ok: true, data: parsed.data };
}

const AGENT_MESSAGES: Record<AgentError["code"], string> = {
  AGENT_BUDGET_EXCEEDED: "Agent 超过了步数、工具次数或时间上限，这一段可以单独重跑。",
  INVALID_MODEL_OUTPUT: "模型交回的结果格式不对，重试一次通常就好。",
  BUDGET_EXCEEDED: "今天遇见手记的模型费用到上限了，演示前可以调高 MEMO_DAILY_BUDGET_YUAN。",
  MODEL_ERROR: "模型服务暂时不可用，请重试。",
  MODEL_RATE_LIMITED: "模型服务限流了，过一会儿再试。",
};

/** 失败也带回 trace：过程页要能看到失败在哪一步（D12） */
export function agentErrorResponse(error: unknown, event: string): NextResponse {
  const agentError = toAgentError(error);
  console.error(JSON.stringify({ event, code: agentError.code, limitHit: agentError.limitHit }));
  return NextResponse.json(
    {
      error: AGENT_MESSAGES[agentError.code],
      code: agentError.code,
      ...(agentError.limitHit ? { limitHit: agentError.limitHit } : {}),
      ...(agentError.trace ? { trace: agentError.trace } : {}),
    },
    { status: agentError.status },
  );
}

export function jobErrorResponse(error: unknown, event: string): NextResponse {
  if (error instanceof JobError) {
    return jsonError(error.status, error.code, error.message, error.extra ?? {});
  }
  if (error instanceof Error && error.message === "BAD_UPLOAD_ID") {
    return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  }
  console.error(JSON.stringify({ event, errorType: error instanceof Error ? error.constructor.name : "unknown" }));
  return jsonError(500, "INTERNAL", "服务器处理失败，请重试");
}

export const uploadIdSchema = z.string().regex(/^up_[A-Za-z0-9_-]{8,40}$/);
