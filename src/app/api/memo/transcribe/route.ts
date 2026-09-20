import { NextResponse } from "next/server";
import { z } from "zod";
import { assertBudget } from "@/lib/agent/budget";
import { agentErrorResponse, jobErrorResponse, memoGuard, readJson, uploadIdSchema } from "@/lib/memo/server/http";
import { startTranscribe } from "@/lib/memo/server/jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  uploadId: uploadIdSchema,
  /** 上次提交结果不明（ASR_SUBMIT_UNKNOWN）时，用户确认可能重复计费后才带 true */
  force: z.boolean().optional(),
});

/** 幂等：已提交过就返回已有任务号（reused: true），不重复提交 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, bodySchema, 1_000);
  if (!body.ok) return body.response;
  try {
    assertBudget();
  } catch (error) {
    return agentErrorResponse(error, "memo_transcribe_budget");
  }
  try {
    return NextResponse.json(await startTranscribe(body.data.uploadId, gate.deviceId, body.data.force ?? false));
  } catch (error) {
    return jobErrorResponse(error, "memo_transcribe_error");
  }
}
