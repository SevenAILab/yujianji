import { NextResponse } from "next/server";
import { z } from "zod";
import { searchMinutes } from "@/lib/feishu/api";
import { feishuBearer, feishuErrorResponse } from "@/lib/memo/server/feishu-http";
import { jsonError, memoGuard, readJson } from "@/lib/memo/server/http";

export const runtime = "nodejs";

const bodySchema = z.object({
  startIso: z.iso.datetime({ offset: true }),
  endIso: z.iso.datetime({ offset: true }),
  pageToken: z.string().max(200).optional(),
});

/** 按"同步到飞书的时间"列妙记（飞书只支持按这个时间搜）；开录时间要逐条读文字记录，见 /preview */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const token = feishuBearer(request);
  if (!token) return jsonError(401, "FEISHU_AUTH_REQUIRED", "还没有授权飞书");
  const body = await readJson(request, bodySchema, 2_000);
  if (!body.ok) return body.response;
  if (Date.parse(body.data.endIso) - Date.parse(body.data.startIso) > 31 * 86_400_000) return jsonError(400, "INVALID_REQUEST", "一次最多查 31 天");
  try {
    return NextResponse.json(await searchMinutes(token, body.data));
  } catch (error) {
    return feishuErrorResponse(error, "feishu_minutes_failed");
  }
}
