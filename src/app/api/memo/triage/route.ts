import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { triageRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { triageWindow } from "@/lib/memo/service/triage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, triageRequestSchema, 400_000);
  if (!body.ok) return body.response;
  try {
    const { value } = await dedupeInflight(inflightKey("triage", body.data.runId, body.data), () => triageWindow(body.data));
    return NextResponse.json(value);
  } catch (error) {
    return agentErrorResponse(error, "memo_triage_error");
  }
}
