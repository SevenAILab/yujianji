// 飞书路由的公共处理（外部设备接入工单 v2 Gate 1）。
// 令牌规则：授权码换来的令牌经一次性 httpOnly cookie 交给页面（不进 URL），之后只存在手机本地，
// 请求时放在 Authorization 头里；服务端不保存、不打日志。
import { NextResponse, type NextRequest } from "next/server";
import { FeishuError } from "../../feishu/api";
import { jsonError } from "./http";

export const STATE_COOKIE = "yjj_fs_state";
export const HANDOFF_COOKIE = "yjj_fs_handoff";
export const CALLBACK_PATH = "/api/memo/feishu/callback";
export const CLAIM_PATH = "/api/memo/feishu/claim";
export const PAGE_PATH = "/memo/feishu";

export function isSecureRequest(request: NextRequest): boolean {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

/** 对外地址：优先 FEISHU_REDIRECT_URI（反向代理后面 request.url 可能是 localhost），否则按转发头推 */
export function publicOrigin(request: NextRequest): string {
  const fromEnv = process.env.FEISHU_REDIRECT_URI?.trim();
  if (fromEnv) return new URL(fromEnv).origin;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

export function redirectUri(request: NextRequest): string {
  return process.env.FEISHU_REDIRECT_URI?.trim() || `${publicOrigin(request)}${CALLBACK_PATH}`;
}

export function pageRedirect(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(PAGE_PATH, publicOrigin(request));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

/** Authorization: Bearer <飞书用户令牌> */
export function feishuBearer(request: Request): string | null {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4000})$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

export function feishuErrorResponse(error: unknown, event: string): NextResponse {
  if (error instanceof FeishuError) {
    console.error(JSON.stringify({ event, code: error.code }));
    return jsonError(error.status, error.code, error.message);
  }
  console.error(JSON.stringify({ event, errorType: error instanceof Error ? error.constructor.name : "unknown" }));
  return jsonError(500, "INTERNAL", "服务器处理失败，请重试");
}

export function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function parseBase64urlJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
