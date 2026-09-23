import { NextResponse } from "next/server";
import { recognizeRequestSchema } from "@/lib/schema";
import { normalizeHistory } from "@/lib/history";
import { buildRecognitionUserText, RECOGNIZE_SYSTEM_PROMPT } from "@/lib/prompt";
import { callVision } from "@/lib/llm";
import { dataUrlByteLength } from "@/lib/image";
import { parseRecognizeResult, RecognizeParseError } from "@/lib/recognize";
import { guard } from "@/lib/api-guard";
import { describeRawShape } from "@/lib/json";
import { isTimeoutLike } from "@/lib/timeout-error";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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

export async function POST(request: Request) {
  const gate = await guard(request);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    const bodyBytes = await request.arrayBuffer();
    if (bodyBytes.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "IMAGE_TOO_LARGE", "请求体超过 4.5MB");
    }
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
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

  async function callWithBudget(
    extraUserText = userText,
    imageDetail: "high" | "low" = "high",
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1_000) {
      throw new Error("模型总响应时间已用尽");
    }
    return callVision({
      imageDataUrl: image,
      systemPrompt: RECOGNIZE_SYSTEM_PROMPT,
      userText: extraUserText,
      imageDetail,
      timeoutMs: Math.min(45_000, remainingMs),
    });
  }

  try {
    let raw: string;
    try {
      raw = await callWithBudget();
    } catch (error) {
      if (!isTimeoutLike(error)) throw error;
      console.info(JSON.stringify({ event: "vision_timeout_retry" }));
      raw = await callWithBudget(userText, "low");
    }

    try {
      return NextResponse.json(parseRecognizeResult(raw, historyEntries));
    } catch (error) {
      if (!(error instanceof RecognizeParseError)) throw error;

      console.warn(
        JSON.stringify({ event: "recognize_parse_failure", code: error.code, detail: error.message, ...describeRawShape(raw) }),
      );

      // 三类可纠正的错误：关联了不存在的 id、编造过往、JSON 格式坏了。纠正一次通常就好。
      const correction =
        error.code === "INVALID_RELATED_ITEM"
          ? `${userText}

上一次输出的关联 id 不合法。请重新检查历史记录，只能使用其中真实出现的 id；如果无法确认，请判定为 first。`
          : error.code === "FABRICATED_HISTORY"
            ? `${userText}

上一次输出编造了用户的过往（${error.message}）。历史记录是空的，用户没有任何过去的记录。
请重写 luck.text、luck.basis 和 memorySentence：不许出现「上次 / 之前 / 去年 / 你记录里」这类说法，
不许出现任何具体年月日，就把它当作用户的第一条记录来写。`
            : error.code === "INVALID_MODEL_OUTPUT"
              ? `${userText}

上一次的输出不是合法 JSON，程序无法解析。请只输出一个 JSON 对象：不要 Markdown 代码块，不要任何解释文字；
字符串里需要引号时用中文引号「」，不要用英文双引号；字符串里不要换行。`
              : null;

      if (!correction) throw error;

      console.info(
        JSON.stringify({ event: "recognize_retry", reason: error.code }),
      );
      const retryRaw = await callWithBudget(correction);
      try {
        return NextResponse.json(parseRecognizeResult(retryRaw, historyEntries));
      } catch (retryError) {
        const code =
          retryError instanceof RecognizeParseError ? retryError.code : "MODEL_ERROR";
        return errorResponse(
          502,
          code,
          code === "FABRICATED_HISTORY"
            ? "这次的解读引用了不存在的历史记录，已拦下，请重试"
            : code === "INVALID_MODEL_OUTPUT"
              ? "模型这次的输出格式不对，请重试"
              : "模型返回了无效的历史关联，请重试",
        );
      }
    }
  } catch (error) {
    if (error instanceof RecognizeParseError) {
      return errorResponse(502, error.code, error.message);
    }

    const message = error instanceof Error ? error.message : "";
    if (isTimeoutLike(error)) {
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
