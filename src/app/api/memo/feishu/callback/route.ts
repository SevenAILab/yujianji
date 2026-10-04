import { type NextRequest } from "next/server";
import { exchangeCode, FeishuError, userInfo } from "@/lib/feishu/api";
import { CALLBACK_PATH, CLAIM_PATH, HANDOFF_COOKIE, isSecureRequest, pageRedirect, putHandoff, redirectUri, STATE_COOKIE } from "@/lib/memo/server/feishu-http";

export const runtime = "nodejs";

/**
 * 飞书回调：核对 state → 授权码换令牌 → 取用户名（用来认出文字记录里的"我"）
 * → 令牌在服务端内存暂存（2 分钟、领取即删），只给 /claim 用的 httpOnly cookie 里放一次性编号，再跳回页面。令牌不进 URL。
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  const clearState = (response: ReturnType<typeof pageRedirect>) => {
    response.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: isSecureRequest(request), sameSite: "lax", path: CALLBACK_PATH, maxAge: 0 });
    return response;
  };
  if (url.searchParams.get("error")) return clearState(pageRedirect(request, { error: "FEISHU_DENIED" }));
  if (!code || !state || !expected || state !== expected || code.length > 512) return clearState(pageRedirect(request, { error: "FEISHU_STATE_MISMATCH" }));
  try {
    const tokens = await exchangeCode(code, redirectUri(request));
    const user = await userInfo(tokens.accessToken).catch(() => ({ name: "" as string, enName: undefined as string | undefined }));
    const response = clearState(pageRedirect(request, { connected: "1" }));
    // cookie 里只放一次性编号；令牌在服务端内存暂存，领取即删（令牌太长，整份放 cookie 会被浏览器丢掉）
    response.cookies.set(HANDOFF_COOKIE, putHandoff({ tokens, names: [user.name, user.enName].filter(Boolean) }), {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: CLAIM_PATH,
      maxAge: 120,
    });
    return response;
  } catch (error) {
    const codeOut = error instanceof FeishuError ? error.code : "FEISHU_ERROR";
    console.error(JSON.stringify({ event: "feishu_callback_failed", code: codeOut }));
    return clearState(pageRedirect(request, { error: codeOut }));
  }
}
