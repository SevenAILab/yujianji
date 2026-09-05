import { NextResponse } from "next/server";
import { allowRequest } from "@/lib/rate-limit";
import { buildMapPins, mapPinsRequestSchema } from "@/lib/map-pins";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_000_000;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, error: message }, { status });
}

export async function POST(request: Request) {
  if (!allowRequest()) {
    return errorResponse(429, "RATE_LIMITED", "请求太频繁，请稍后再试");
  }

  let body: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "地图地点数据超过 1MB");
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求不是有效 JSON");
  }

  const parsed = mapPinsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "地点或记录信息格式不正确");
  }

  const pins = buildMapPins(parsed.data);
  return NextResponse.json({
    pins,
    locationCount: pins.length,
    memoryCount: pins.reduce((sum, pin) => sum + pin.memoryCount, 0),
  });
}
