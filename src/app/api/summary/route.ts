import { NextResponse } from "next/server";
import { z } from "zod";
import { callVision } from "@/lib/llm";
import { normalizeHistory } from "@/lib/history";
import { buildSummaryUserText, cleanSummary, SUMMARY_SYSTEM_PROMPT } from "@/lib/summary";
import { allowRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  history: z.union([
    z.array(
      z.object({
        id: z.string().min(1).max(120),
        name: z.string().min(1).max(80),
        category: z.enum([
          "animal",
          "plant",
          "mineral",
          "landscape",
          "sky",
          "food",
          "artifact",
          "other",
        ]),
        place: z.string().max(120),
        date: z.string().max(40),
        userNote: z.string().max(120),
      }),
    ).max(200),
    z.string().max(120_000),
  ]),
});

export async function POST(request: Request) {
  if (!allowRequest()) {
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "请求太频繁，请稍后再试" },
      { status: 429 },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_000_000) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "总结记录太长，请缩小日期范围" },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "总结请求格式不正确" },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "总结记录格式不正确" },
      { status: 400 },
    );
  }

  const normalized = normalizeHistory(parsed.data.history);
  if (normalized.truncated) {
    console.info(JSON.stringify({ event: "history_truncated", limit: 200 }));
  }
  const history = normalized.entries;
  if (!history.length) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "这段时间还没有可总结的遇见" },
      { status: 400 },
    );
  }

  try {
    const raw = await callVision({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      userText: buildSummaryUserText(history),
      timeoutMs: 55_000,
    });
    const summary = cleanSummary(raw);
    if (!summary) throw new Error("模型返回空总结");
    return NextResponse.json({ summary });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("timeout") || message.includes("abort")) {
      return NextResponse.json(
        { code: "MODEL_TIMEOUT", error: "总结响应超时，请重试" },
        { status: 504 },
      );
    }
    console.error(
      JSON.stringify({
        event: "summary_error",
        errorType: error instanceof Error ? error.constructor.name : "unknown",
      }),
    );
    return NextResponse.json(
      { code: "MODEL_ERROR", error: "旅程总结暂时不可用，请重试" },
      { status: 502 },
    );
  }
}
