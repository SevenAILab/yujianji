import { NextResponse } from "next/server";
import { allowRequest } from "@/lib/rate-limit";
import { generateJourney, journeyGenerationRequestSchema } from "@/lib/journey-generator";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!allowRequest()) {
    return NextResponse.json({ code: "RATE_LIMITED", error: "请求太频繁，请稍后再试" }, { status: 429 });
  }

  let body: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1_000_000) {
      return NextResponse.json({ code: "INVALID_REQUEST", error: "记录过多，请缩小日期范围" }, { status: 413 });
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ code: "INVALID_REQUEST", error: "旅程请求格式不正确" }, { status: 400 });
  }

  const parsed = journeyGenerationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_REQUEST", error: parsed.error.issues[0]?.message ?? "旅程记录格式不正确" }, { status: 400 });
  }

  const journey = generateJourney(parsed.data);
  if (!journey) {
    return NextResponse.json({ code: "NO_RECORDS", error: "这个时间段还没有可以生成旅程的记录" }, { status: 404 });
  }
  if (!journey.regions.length) {
    return NextResponse.json({ code: "REGION_NOT_FOUND", error: "这些地点暂时无法匹配一级行政区，请检查地点坐标" }, { status: 422 });
  }

  return NextResponse.json({ journey });
}

