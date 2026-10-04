import { NextResponse } from "next/server";
import { z } from "zod";
import { refreshTokens } from "@/lib/feishu/api";
import { feishuErrorResponse } from "@/lib/memo/server/feishu-http";
import { memoGuard, readJson } from "@/lib/memo/server/http";

export const runtime = "nodejs";

const bodySchema = z.object({ refreshToken: z.string().min(10).max(4_000) });

/** 刷新令牌要用应用密钥，所以必须经服务端；只转换，不保存 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, bodySchema, 8_000);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({ tokens: await refreshTokens(body.data.refreshToken) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return feishuErrorResponse(error, "feishu_refresh_failed");
  }
}
