import { NextResponse } from "next/server";
import { z } from "zod";
import { MINUTE_TOKEN_PATTERN } from "@/lib/feishu/api";
import { feishuBearer, feishuErrorResponse } from "@/lib/memo/server/feishu-http";
import { transcriptFromMinute } from "@/lib/memo/server/feishu-import";
import { jsonError, memoGuard, readJson } from "@/lib/memo/server/http";

export const runtime = "nodejs";
// 要下载整段音频再算响度：1 小时的录音约 30MB
export const maxDuration = 300;

const bodySchema = z.object({
  token: z.string().regex(MINUTE_TOKEN_PATTERN),
  /** 授权用户在飞书里的名字：文字记录里同名的 @说话人 就是"我" */
  ownerNames: z.array(z.string().min(1).max(60)).max(2).default([]),
});

/** 文字记录 → 句子时间轴 + 按说话人的响度。和语音识别的结果同形，但不调用语音识别、不花钱 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const token = feishuBearer(request);
  if (!token) return jsonError(401, "FEISHU_AUTH_REQUIRED", "还没有授权飞书");
  const body = await readJson(request, bodySchema, 2_000);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(await transcriptFromMinute(token, body.data.token, body.data.ownerNames));
  } catch (error) {
    return feishuErrorResponse(error, "feishu_transcript_failed");
  }
}
