import { NextResponse } from "next/server";
import { dedupeInflight, inflightKey } from "@/lib/agent/inflight";
import { matchRequestSchema } from "@/lib/memo/schema";
import { agentErrorResponse, memoGuard, readJson } from "@/lib/memo/server/http";
import { matchDayPhotos } from "@/lib/memo/service/match";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, matchRequestSchema, 200_000);
  if (!body.ok) return body.response;
  try {
    // 同一 runId、同一批素材的并发请求合并成一次，重复点击不重复花钱
    const { value } = await dedupeInflight(inflightKey("match", body.data.runId, body.data), () => matchDayPhotos(body.data));
    return NextResponse.json(value);
  } catch (error) {
    return agentErrorResponse(error, "memo_match_error");
  }
}
