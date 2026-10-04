// 飞书授权与导入路由（外部设备接入工单 v2 Gate 1）：state 校验、令牌不进 URL、一次性领取、缺授权直接拒绝。
// 飞书接口用 fetch 桩，不打真实网络。
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as authorize } from "@/app/api/memo/feishu/authorize/route";
import { GET as callback } from "@/app/api/memo/feishu/callback/route";
import { POST as claim } from "@/app/api/memo/feishu/claim/route";
import { POST as transcript } from "@/app/api/memo/feishu/transcript/route";
import { POST as minutes } from "@/app/api/memo/feishu/minutes/route";
import { base64urlJson, HANDOFF_COOKIE, STATE_COOKIE } from "@/lib/memo/server/feishu-http";

const DEVICE = "dev_test_feishu_routes_0001";
// 全是虚构值
const FAKE_MINUTE = "obcnfakeminute0000000001";
const FAKE_USER_TOKEN = "u-fake-for-tests";
// 想借妙记标识拼出别的接口路径
const PATH_TRAVERSAL = "../../open-apis/im/v1/messages";

beforeEach(() => {
  vi.stubEnv("FEISHU_APP_ID", "cli_test_app");
  vi.stubEnv("FEISHU_APP_SECRET", "test_secret");
  vi.stubEnv("FEISHU_REDIRECT_URI", "https://yujianji.example.com/api/memo/feishu/callback");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function req(url: string, init: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers = new Headers({ "x-device-id": DEVICE, ...(init.headers ?? {}) });
  if (init.cookies) headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

describe("授权", () => {
  it("没配置飞书应用：跳回页面并说明，不去飞书", async () => {
    vi.stubEnv("FEISHU_APP_ID", "");
    const res = await authorize(req("https://yujianji.example.com/api/memo/feishu/authorize"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://yujianji.example.com/memo/feishu?error=FEISHU_NOT_CONFIGURED");
  });

  it("跳到飞书授权页，state 放进只给回调用的 httpOnly cookie", async () => {
    const res = await authorize(req("https://yujianji.example.com/api/memo/feishu/authorize"));
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    expect(location.searchParams.get("client_id")).toBe("cli_test_app");
    expect(location.searchParams.get("redirect_uri")).toBe("https://yujianji.example.com/api/memo/feishu/callback");
    expect(location.searchParams.get("scope")).toContain("minutes:minutes.media:export");
    const state = location.searchParams.get("state");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${STATE_COOKIE}=${state}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("Path=/api/memo/feishu/callback");
  });

  it("state 对不上：拒绝，不换令牌", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await callback(req("https://yujianji.example.com/api/memo/feishu/callback?code=abc&state=forged", { cookies: { [STATE_COOKIE]: "real" } }));
    expect(res.headers.get("location")).toContain("error=FEISHU_STATE_MISMATCH");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("回调成功：令牌只进一次性 cookie（只给 /claim），跳回页面的 URL 里没有令牌", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/open-apis/authen/v2/oauth/token")) {
          return Response.json({ code: 0, access_token: FAKE_USER_TOKEN, expires_in: 7200, refresh_token: "ur-fake", refresh_token_expires_in: 604800 });
        }
        if (url.endsWith("/open-apis/authen/v1/user_info")) return Response.json({ code: 0, data: { name: "Seven", en_name: "seven" } });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const res = await callback(req("https://yujianji.example.com/api/memo/feishu/callback?code=abc&state=s1", { cookies: { [STATE_COOKIE]: "s1" } }));
    const location = res.headers.get("location")!;
    expect(location).toBe("https://yujianji.example.com/memo/feishu?connected=1");
    expect(location).not.toContain(FAKE_USER_TOKEN);
    const cookies = res.headers.getSetCookie();
    const handoff = cookies.find((c) => c.startsWith(`${HANDOFF_COOKIE}=`))!;
    expect(handoff).toContain("Path=/api/memo/feishu/claim");
    expect(handoff.toLowerCase()).toContain("httponly");
    expect(handoff).toMatch(/Max-Age=120/);
  });

  it("领取一次就清掉；没有 cookie 就要求重新授权", async () => {
    const value = base64urlJson({ tokens: { accessToken: FAKE_USER_TOKEN, expiresAt: 1 }, names: ["Seven"] });
    const res = await claim(req("https://yujianji.example.com/api/memo/feishu/claim", { method: "POST", cookies: { [HANDOFF_COOKIE]: value }, body: {} }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: { accessToken: FAKE_USER_TOKEN, expiresAt: 1 }, names: ["Seven"] });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${HANDOFF_COOKIE}=;.*Max-Age=0`));
    const again = await claim(req("https://yujianji.example.com/api/memo/feishu/claim", { method: "POST", body: {} }));
    expect(again.status).toBe(404);
  });
});

describe("导入接口", () => {
  it("没带飞书令牌直接 401，不碰飞书", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await transcript(req("https://yujianji.example.com/api/memo/feishu/transcript", { method: "POST", body: { token: FAKE_MINUTE } }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("妙记标识必须合法，不能借路径访问别的接口", async () => {
    const res = await transcript(
      req("https://yujianji.example.com/api/memo/feishu/transcript", { method: "POST", headers: { authorization: `Bearer ${FAKE_USER_TOKEN}` }, body: { token: PATH_TRAVERSAL } }),
    );
    expect(res.status).toBe(400);
  });

  it("飞书说令牌失效 → 401 FEISHU_AUTH_EXPIRED；令牌只出现在请求头", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return Response.json({ code: 99991677, msg: "token expired" }, { status: 400 });
      }),
    );
    const res = await minutes(
      req("https://yujianji.example.com/api/memo/feishu/minutes", {
        method: "POST",
        headers: { authorization: `Bearer ${FAKE_USER_TOKEN}` },
        body: { startIso: "2026-10-01T00:00:00+08:00", endIso: "2026-10-03T23:59:59+08:00" },
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("FEISHU_AUTH_EXPIRED");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://open.feishu.cn/open-apis/minutes/v1/minutes/search?page_size=30");
    expect(seen[0].url).not.toContain(FAKE_USER_TOKEN);
    expect(seen[0].auth).toBe(`Bearer ${FAKE_USER_TOKEN}`);
  });
});
