import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { judgeRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { judgeWindow } from "@/lib/memo/service/judge";

export const runtime = "nodejs";
// 用智谱时判断截止时间可调到 90 秒（MEMO_JUDGE_DEADLINE_MS），平台的函数时长上限要留够
export const maxDuration = 120;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, judgeRequestSchema, 1_000_000);
  if (!body.ok) return body.response;
  try {
    const { value } = await dedupeInflight(inflightKey("judge", body.data.runId, body.data), () => judgeWindow(body.data));
    return NextResponse.json(value);
  } catch (error) {
    return agentErrorResponse(error, "memo_judge_error");
  }
}
