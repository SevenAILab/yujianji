import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, feishuConfigured } from "@/lib/feishu/api";
import { CALLBACK_PATH, isSecureRequest, pageRedirect, redirectUri, STATE_COOKIE } from "@/lib/memo/server/feishu-http";

export const runtime = "nodejs";

/** 跳到飞书授权页。state 放 httpOnly cookie，回调时核对（防 CSRF） */
export async function GET(request: NextRequest) {
  if (!feishuConfigured()) return pageRedirect(request, { error: "FEISHU_NOT_CONFIGURED" });
  const state = randomUUID();
  const response = NextResponse.redirect(authorizeUrl({ state, redirectUri: redirectUri(request) }), 303);
  response.cookies.set(STATE_COOKIE, state, { httpOnly: true, secure: isSecureRequest(request), sameSite: "lax", path: CALLBACK_PATH, maxAge: 600 });
  return response;
}
