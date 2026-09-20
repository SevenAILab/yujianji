import { NextResponse } from "next/server";
import { z } from "zod";
import { jobErrorResponse, memoGuard, readJson, uploadIdSchema } from "@/lib/memo/server/http";
import { startPrepare } from "@/lib/memo/server/jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ uploadId: uploadIdSchema });

/** 转码 + 上传临时存储在进程内异步执行，立即返回，前端轮询 /prepare/status（D7）。重复调用返回当前状态。 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, bodySchema, 1_000);
  if (!body.ok) return body.response;
  try {
    const state = await startPrepare(body.data.uploadId, gate.deviceId);
    const status = state.parts?.length ? "done" : state.phase === "failed" ? "failed" : "running";
    return NextResponse.json({ status });
  } catch (error) {
    return jobErrorResponse(error, "memo_prepare_error");
  }
}
