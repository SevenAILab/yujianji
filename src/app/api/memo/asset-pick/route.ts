import { NextResponse } from "next/server";
import { assertBudget } from "@/lib/agent/budget";
import { agentErrorResponse, jsonError, memoGuard, readJson } from "@/lib/memo/server/http";
import { assetPickRequestSchema, pickAsset } from "@/lib/memo/service/asset-pick";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 以声定图：2–3 张候选拼图 + 原话 → 选一张或不选（外部设备接入工单 v2 Gate 2） */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "spend");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, assetPickRequestSchema, 1_000_000);
  if (!body.ok) return body.response;
  try {
    assertBudget();
    return NextResponse.json(await pickAsset(body.data));
  } catch (error) {
    const status = (error as { status?: number })?.status;
    // 识图服务拒绝（额度 / 密钥）单独说清楚，不混成"处理失败"
    if (status === 401 || status === 403) return jsonError(503, "VISION_UNAVAILABLE", "识图服务拒绝调用（额度用完或密钥失效），这次先不配图");
    return agentErrorResponse(error, "memo_asset_pick_error");
  }
}
