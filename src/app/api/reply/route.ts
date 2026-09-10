import { NextResponse } from "next/server";
import { z } from "zod";
import { callVision } from "@/lib/llm";
import { guard } from "@/lib/api-guard";
import { REPLY_SYSTEM_PROMPT } from "@/lib/prompt";
import { isTimeoutLike } from "@/lib/timeout-error";
import { parseReplyResult, ReplyValidationError } from "@/lib/reply";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  itemName: z.string().min(1).max(60),
  userNote: z.string().max(300),
  question: z.string().min(1).max(120),
  answer: z.string().min(1).max(300),
});

export async function POST(request: Request) {
  const gate = await guard(request);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_REQUEST", error: "请求格式不正确" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_REQUEST", error: "回应请求格式不正确" }, { status: 400 });
  }

  const { itemName, userNote, question, answer } = parsed.data;
  const userText = `藏品：${itemName}
<user_note>${userNote}</user_note>
<your_question>${question}</your_question>
<user_answer>${answer}</user_answer>

请只返回 JSON。`;

  try {
    const raw = await callVision({
      systemPrompt: REPLY_SYSTEM_PROMPT,
      userText,
      timeoutMs: 25_000,
    });
    try {
      return NextResponse.json({ reply: parseReplyResult(raw) });
    } catch (error) {
      if (!(error instanceof ReplyValidationError)) throw error;
      // 用户认真答了一句，这一次回应不能随便丢。说清楚哪里不合格，再给一次机会。
      console.info(JSON.stringify({ event: "reply_retry", reason: error.reason }));
      const retryRaw = await callVision({
        systemPrompt: REPLY_SYSTEM_PROMPT,
        userText: `${userText}

上一次的回应不符合要求（${error.message}）。请重写：只返回 {"reply":"…"}，一句话，不超过 40 个汉字，不以问号结尾，全部使用中文。`,
        timeoutMs: 20_000,
      });
      return NextResponse.json({ reply: parseReplyResult(retryRaw) });
    }
  } catch (error) {
    if (isTimeoutLike(error)) {
      return NextResponse.json({ code: "MODEL_TIMEOUT", error: "回应生成超时，请重试" }, { status: 504 });
    }
    console.error(JSON.stringify({
      event: "reply_error",
      errorType: error instanceof Error ? error.constructor.name : "unknown",
    }));
    return NextResponse.json({ code: "MODEL_ERROR", error: "回应暂时生成不出来，请重试" }, { status: 502 });
  }
}
