import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { judgeRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { judgeWindow } from "@/lib/memo/service/judge";

export const runtime = "nodejs";
export const maxDuration = 60;

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
