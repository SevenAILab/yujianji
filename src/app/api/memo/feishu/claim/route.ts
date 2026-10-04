import { NextResponse, type NextRequest } from "next/server";
import { CLAIM_PATH, HANDOFF_COOKIE, isSecureRequest, parseBase64urlJson } from "@/lib/memo/server/feishu-http";
import { jsonError, memoGuard } from "@/lib/memo/server/http";
import type { FeishuTokens } from "@/lib/feishu/api";

export const runtime = "nodejs";

/** 页面领一次令牌：读一次性 cookie → 返回 → 立刻清掉。之后令牌只在手机本地 */
export async function POST(request: NextRequest) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const handoff = parseBase64urlJson<{ tokens: FeishuTokens; names: string[] }>(request.cookies.get(HANDOFF_COOKIE)?.value);
  const response = handoff?.tokens?.accessToken
    ? NextResponse.json({ tokens: handoff.tokens, names: (handoff.names ?? []).slice(0, 2) }, { headers: { "Cache-Control": "no-store" } })
    : jsonError(404, "FEISHU_HANDOFF_MISSING", "授权结果已经领取过或过期了，请重新授权");
  response.cookies.set(HANDOFF_COOKIE, "", { httpOnly: true, secure: isSecureRequest(request), sameSite: "strict", path: CLAIM_PATH, maxAge: 0 });
  return response;
}
