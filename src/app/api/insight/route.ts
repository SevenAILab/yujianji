import { NextResponse } from "next/server";
import { z } from "zod";
import { callVision } from "@/lib/llm";
import { extractJsonObject } from "@/lib/json";
import { INSIGHT_SYSTEM_PROMPT } from "@/lib/prompt";
import { allowRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 入参只有一条已经算好的事实字符串。
 * 绝不接收藏品列表——事实由前端的纯函数算出，模型只负责润色，因此不可能编造。
 */
const requestSchema = z.object({
  fact: z.string().min(1).max(200),
});

const responseSchema = z.object({
  line: z.string().min(1),
});

export async function POST(request: Request) {
  if (!allowRequest(120, "insight")) {
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "请求太频繁，请稍后再试" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "请求格式不正确" },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "事实格式不正确" },
      { status: 400 },
    );
  }

  try {
    const raw = await callVision({
      systemPrompt: INSIGHT_SYSTEM_PROMPT,
      userText: `事实：${parsed.data.fact}`,
      timeoutMs: 20_000,
    });
    const result = responseSchema.parse(extractJsonObject(raw));
    const line = result.line.replace(/^["“”「」]+|["“”「」]+$/g, "").trim();
    if (!line) throw new Error("模型返回空句子");
    if (line.length > 40) throw new Error("模型返回超长句子");
    return NextResponse.json({ line });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    console.error(
      JSON.stringify({
        event: "insight_error",
        errorType: error instanceof Error ? error.constructor.name : "unknown",
      }),
    );
    if (message.includes("timeout") || message.includes("abort")) {
      return NextResponse.json(
        { code: "MODEL_TIMEOUT", error: "这句话生成超时" },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { code: "MODEL_ERROR", error: "这句话暂时生成不出来" },
      { status: 502 },
    );
  }
}
