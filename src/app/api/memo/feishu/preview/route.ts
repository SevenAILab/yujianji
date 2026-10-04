import { NextResponse } from "next/server";
import { z } from "zod";
import { MINUTE_TOKEN_PATTERN } from "@/lib/feishu/api";
import { feishuBearer, feishuErrorResponse } from "@/lib/memo/server/feishu-http";
import { previewMinute } from "@/lib/memo/server/feishu-import";
import { jsonError, memoGuard, readJson } from "@/lib/memo/server/http";

export const runtime = "nodejs";

const bodySchema = z.object({ token: z.string().regex(MINUTE_TOKEN_PATTERN) });

/** 一条妙记的开录时间（来自文字记录）、时长、段数：给用户勾选和核对时间用。不下载音频 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const token = feishuBearer(request);
  if (!token) return jsonError(401, "FEISHU_AUTH_REQUIRED", "还没有授权飞书");
  const body = await readJson(request, bodySchema, 1_000);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(await previewMinute(token, body.data.token));
  } catch (error) {
    return feishuErrorResponse(error, "feishu_preview_failed");
  }
}
