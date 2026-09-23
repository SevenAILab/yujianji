// 提交一张照片建模（付费：Tripo 约 30 积分/件）。闸门：通用设备配额 + 建模单独的全站/单设备日上限。
import { NextResponse } from "next/server";
import { guard } from "@/lib/api-guard";
import { incr } from "@/lib/kv";
import { Model3dError, model3dConfigured, submitPhoto } from "@/lib/model3d/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const ITEM_ID = /^[A-Za-z0-9_-]{1,120}$/;

function limit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const fail = (status: number, code: string, error: string) => NextResponse.json({ code, error }, { status });

export async function POST(request: Request) {
  if (!model3dConfigured()) return fail(503, "MODEL3D_OFF", "建模服务还没开通");
  const gate = await guard(request);
  if (!gate.ok) return gate.response;

  let body: { image?: unknown; itemId?: unknown };
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return fail(413, "IMAGE_TOO_LARGE", "照片太大");
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(400, "INVALID_REQUEST", "请求格式不对");
  }
  const match = typeof body.image === "string" ? /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(body.image) : null;
  if (!match || typeof body.itemId !== "string" || !ITEM_ID.test(body.itemId)) return fail(400, "INVALID_REQUEST", "请求格式不对");

  const day = new Date().toISOString().slice(0, 10);
  const global = await incr(`model3d:${day}`, 90_000);
  const device = await incr(`model3d:${gate.deviceId}:${day}`, 90_000);
  if (global > limit("MODEL3D_DAILY_LIMIT", 40)) return fail(503, "DAILY_BUDGET_EXHAUSTED", "今天的建模额度用完了，明天再来");
  if (device > limit("MODEL3D_DEVICE_DAILY_LIMIT", 6)) return fail(429, "RATE_LIMITED", "你今天的建模次数用完了，明天再来");

  try {
    const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
    const job = await submitPhoto({ deviceId: gate.deviceId, itemId: body.itemId, bytes: Buffer.from(match[2], "base64"), mime });
    return NextResponse.json({ taskId: job.taskId, state: job.state });
  } catch (error) {
    console.error(JSON.stringify({ event: "model3d_submit_failed", error: String(error).slice(0, 200) }));
    return error instanceof Model3dError ? fail(error.status, error.code, error.message) : fail(502, "MODEL_ERROR", "建模服务暂时不可用");
  }
}
