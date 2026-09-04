import { NextResponse } from "next/server";
import { recognizeRequestSchema } from "@/lib/schema";
import { normalizeHistory } from "@/lib/history";
import { buildRecognitionUserText, RECOGNIZE_SYSTEM_PROMPT } from "@/lib/prompt";
import { callVision } from "@/lib/llm";
import { dataUrlByteLength } from "@/lib/image";
import { parseRecognizeResult, RecognizeParseError } from "@/lib/recognize";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const requestTimes: number[] = [];

function errorResponse(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

function isAllowedImageDataUrl(value: string): boolean {
  return /^data:image\/(?:jpeg|jpg|png);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
}

function allowRequest(): boolean {
  const now = Date.now();
  while (requestTimes[0] && now - requestTimes[0] > 60_000) {
    requestTimes.shift();
  }
  if (requestTimes.length >= 120) {
    return false;
  }
  requestTimes.push(now);
  return true;
}

export async function POST(request: Request) {
  if (!allowRequest()) {
    return errorResponse(429, "RATE_LIMITED", "请求太频繁，请稍后再试");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return errorResponse(413, "IMAGE_TOO_LARGE", "请求体超过 4.5MB");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求不是有效 JSON");
  }

  const parsedRequest = recognizeRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return errorResponse(400, "INVALID_REQUEST", "照片、原话或历史记录格式不正确");
  }

  const { image, userNote, history } = parsedRequest.data;
  if (!isAllowedImageDataUrl(image)) {
    return errorResponse(400, "INVALID_REQUEST", "只支持 JPEG 或 PNG 图片");
  }
  if (dataUrlByteLength(image) > MAX_IMAGE_BYTES) {
    return errorResponse(413, "IMAGE_TOO_LARGE", "图片压缩后仍超过 2MB");
  }

  const normalizedHistory = normalizeHistory(history);
  if (normalizedHistory.truncated) {
    console.info(JSON.stringify({ event: "history_truncated", limit: 200 }));
  }
  const historyEntries = normalizedHistory.entries;
  const userText = buildRecognitionUserText(userNote, historyEntries);
  const deadline = Date.now() + 55_000;

  async function callWithBudget(extraUserText = userText) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1_000) {
      throw new Error("模型总响应时间已用尽");
    }
    return callVision({
      imageDataUrl: image,
      systemPrompt: RECOGNIZE_SYSTEM_PROMPT,
      userText: extraUserText,
      timeoutMs: Math.min(26_000, remainingMs),
    });
  }

  try {
    const raw = await callWithBudget();

    try {
      return NextResponse.json(parseRecognizeResult(raw, historyEntries));
    } catch (error) {
      if (
        error instanceof RecognizeParseError &&
        error.code === "INVALID_RELATED_ITEM"
      ) {
        const retryRaw = await callWithBudget(`${userText}

上一次输出的关联 id 不合法。请重新检查历史记录，只能使用其中真实出现的 id；如果无法确认，请判定为 first。`,
        );
        try {
          return NextResponse.json(
            parseRecognizeResult(retryRaw, historyEntries),
          );
        } catch {
          return errorResponse(
            502,
            "INVALID_RELATED_ITEM",
            "模型返回了无效的历史关联，请重试",
          );
        }
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof RecognizeParseError) {
      return errorResponse(502, error.code, error.message);
    }

    const message = error instanceof Error ? error.message : "";
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("timeout") || lowerMessage.includes("abort")) {
      return errorResponse(504, "MODEL_TIMEOUT", "模型响应超时，请重试");
    }
    if (message.includes("缺少 DASHSCOPE_API_KEY")) {
      return errorResponse(503, "MODEL_ERROR", "模型服务尚未配置");
    }
    console.error(
      JSON.stringify({
        event: "vision_error",
        errorType: error instanceof Error ? error.constructor.name : "unknown",
      }),
    );
    return errorResponse(502, "MODEL_ERROR", "模型服务暂时不可用，请重试");
  }
}
