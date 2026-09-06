import { NextResponse } from "next/server";
import { encounterAvRequestSchema } from "@/lib/schema";
import { dataUrlByteLength } from "@/lib/image";
import { normalizeHistory } from "@/lib/history";
import { allowRequest } from "@/lib/rate-limit";
import { buildEncounterAvUserText, ENCOUNTER_AV_SYSTEM_PROMPT } from "@/lib/prompt";
import { callOmni } from "@/lib/llm";
import { isTimeoutLike } from "@/lib/timeout-error";
import {
  assertReunionPreserved,
  AvParseError,
  extractAvReunionExpectations,
  parseAvResult,
} from "@/lib/av-result";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4_200_000;
const MAX_AUDIO_BYTES = 1_950_000;
const MAX_FRAME_BYTES = 1_100_000;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

function isJpegDataUrl(value: string): boolean {
  return /^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/i.test(value);
}

function isWavDataUrl(value: string): boolean {
  return /^data:audio\/wav;base64,[A-Za-z0-9+/=\s]+$/i.test(value);
}

export async function POST(request: Request) {
  if (!allowRequest()) {
    return errorResponse(429, "RATE_LIMITED", "请求太频繁，请稍后再试");
  }

  let body: unknown;
  try {
    const bodyBytes = await request.arrayBuffer();
    if (bodyBytes.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "视频拆包后的请求仍然太大");
    }
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "请求不是有效 JSON");
  }

  const parsed = encounterAvRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_REQUEST", "视频帧、音频或历史格式不正确");
  }
  const { frames, audioDataUrl } = parsed.data;
  const normalizedHistory = normalizeHistory(parsed.data.history);
  if (normalizedHistory.truncated) {
    console.info(JSON.stringify({ event: "history_truncated", limit: 200 }));
  }
  const history = normalizedHistory.entries;
  if (
    frames.some((frame) => !isJpegDataUrl(frame.dataUrl)) ||
    (audioDataUrl !== null && !isWavDataUrl(audioDataUrl))
  ) {
    return errorResponse(400, "INVALID_REQUEST", "只支持 JPEG 帧和 WAV 音频");
  }

  const frameBytes = frames.reduce(
    (total, frame) => total + dataUrlByteLength(frame.dataUrl),
    0,
  );
  const audioBytes = audioDataUrl ? dataUrlByteLength(audioDataUrl) : 0;
  if (frameBytes > MAX_FRAME_BYTES) {
    return errorResponse(413, "FRAMES_TOO_LARGE", "抽取的画面帧仍然太大");
  }
  if (audioBytes > MAX_AUDIO_BYTES) {
    return errorResponse(413, "AUDIO_TOO_LARGE", "音频超过可识别的大小");
  }

  const frameTimes = frames.map((frame) => frame.atSec);
  const userText = buildEncounterAvUserText(history, frameTimes, Boolean(audioDataUrl));
  const deadline = Date.now() + 55_000;

  async function callWithBudget(extraText = userText) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1_000) throw new Error("模型总响应时间已用尽");
    return callOmni({
      frames: frames.map((frame) => frame.dataUrl),
      frameTimes,
      audioDataUrl,
      systemPrompt: ENCOUNTER_AV_SYSTEM_PROMPT,
      userText: extraText,
      timeoutMs: remainingMs,
    });
  }

  try {
    const raw = await callWithBudget();
    try {
      return NextResponse.json(parseAvResult(raw, history, frames.length));
    } catch (error) {
      if (
        error instanceof AvParseError &&
        error.code === "INVALID_RELATED_ITEM"
      ) {
        const expectations = extractAvReunionExpectations(raw);
        const retryRaw = await callWithBudget(`${userText}

上一次输出的历史关联不一致。请逐字核对 history 中的 id、name 和 category；必须保留同一对象的 reunion，并修正为真实存在且名称完全一致的历史记录；无法确认具体历史 id 时返回 INVALID_MODEL_OUTPUT，不要改成 first。`);
        const retryResult = parseAvResult(retryRaw, history, frames.length);
        assertReunionPreserved(retryResult, expectations);
        return NextResponse.json(retryResult);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AvParseError) {
      return errorResponse(502, error.code, error.message);
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (isTimeoutLike(error)) {
      return errorResponse(504, "MODEL_TIMEOUT", "视频显影超时，请重试");
    }
    if (message.includes("缺少 dashscope_api_key")) {
      return errorResponse(503, "MODEL_ERROR", "模型服务尚未配置");
    }
    console.error(
      JSON.stringify({
        event: "omni_error",
        errorType: error instanceof Error ? error.constructor.name : "unknown",
        frameCount: frames.length,
        frameBytes,
        audioBytes,
      }),
    );
    return errorResponse(502, "MODEL_ERROR", "视频识别服务暂时不可用，请重试");
  }
}
