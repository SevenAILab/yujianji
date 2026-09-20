import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { reflectRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { reflectProfile } from "@/lib/memo/service/reflect";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, reflectRequestSchema, 400_000);
  if (!body.ok) return body.response;
  try {
    const { value } = await dedupeInflight(inflightKey("reflect", body.data.runId, body.data), () => reflectProfile(body.data));
    return NextResponse.json({
      ops: value.ops,
      rejected: value.rejected.map((r) => ({ op: r.op.op, text: r.op.text, reason: r.reason })),
      summary: value.summary,
      trace: value.trace,
    });
  } catch (error) {
    return agentErrorResponse(error, "memo_reflect_error");
  }
}
