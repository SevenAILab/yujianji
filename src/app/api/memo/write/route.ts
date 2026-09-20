import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { writeRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { writeDiary } from "@/lib/memo/service/write";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, writeRequestSchema, 600_000);
  if (!body.ok) return body.response;
  try {
    const { value } = await dedupeInflight(inflightKey("write", body.data.runId, body.data), () => writeDiary(body.data));
    return NextResponse.json(value);
  } catch (error) {
    return agentErrorResponse(error, "memo_write_error");
  }
}
