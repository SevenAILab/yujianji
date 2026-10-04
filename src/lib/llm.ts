import OpenAI from "openai";

interface CallVisionOptions {
  imageDataUrl?: string;
  systemPrompt: string;
  userText: string;
  imageDetail?: "high" | "low";
  model?: string;
  enableThinking?: boolean;
  jsonMode?: boolean;
  timeoutMs?: number;
}

interface CallOmniOptions {
  frames: string[];
  frameTimes: number[];
  /** 为 null 时只送画面帧：浏览器解不出音轨，或模型不吃 input_audio。 */
  audioDataUrl: string | null;
  systemPrompt: string;
  userText: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * 识图服务商可切换（外部设备接入工单 v2 Gate 0）：VISION_PROVIDER=dashscope（默认）| zhipu。
 * 智谱用 ZHIPU_API_KEY / ZHIPU_BASE_URL，默认模型 glm-4.6v-flash（免费，2026-10-03 实测可用）。
 * callOmni（视频理解）不受影响，永远走 DashScope。
 */
export type VisionProvider = "dashscope" | "zhipu";

export function visionProvider(): VisionProvider {
  return process.env.VISION_PROVIDER?.trim() === "zhipu" ? "zhipu" : "dashscope";
}

export function defaultVisionModel(provider = visionProvider()): string {
  return provider === "zhipu"
    ? process.env.ZHIPU_VISION_MODEL?.trim() || "glm-4.6v-flash"
    : process.env.VISION_MODEL ?? "qwen3-vl-plus";
}

function getClient(timeoutMs = 55_000, provider: VisionProvider = "dashscope"): OpenAI {
  const apiKey = provider === "zhipu" ? process.env.ZHIPU_API_KEY?.trim() : process.env.DASHSCOPE_API_KEY;
  const baseURL =
    provider === "zhipu"
      ? process.env.ZHIPU_BASE_URL?.trim() || "https://open.bigmodel.cn/api/paas/v4"
      : process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

  if (!apiKey) {
    throw new Error(provider === "zhipu" ? "缺少 ZHIPU_API_KEY，请配置 .env.local" : "缺少 DASHSCOPE_API_KEY，请配置 .env.local");
  }

  return new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });
}

function getVisionModels(primaryModel: string, provider: VisionProvider): string[] {
  // 备用模型名单是千问的，换到智谱时不用
  if (provider === "zhipu") return [primaryModel];
  const fallbacks = (process.env.VISION_FALLBACK_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return Array.from(new Set([primaryModel, ...fallbacks]));
}

function isRateLimitError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("429") || message.includes("too many requests");
}

async function requestVision(
  client: OpenAI,
  model: string,
  userContent: Array<Record<string, unknown>>,
  systemPrompt: string,
  enableThinking: boolean,
  jsonMode: boolean,
  provider: VisionProvider = "dashscope",
): Promise<string> {
  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    // 900 对 flash 类模型偏紧：它们话多，截断后 JSON 就配不上括号了。
    max_tokens: 1500,
  };

  if (provider === "zhipu") {
    // 智谱默认会先思考，识图不需要，显式关掉（写法与千问不同）
    request.thinking = { type: enableThinking ? "enabled" : "disabled" };
  } else if (enableThinking) {
    request.enable_thinking = true;
  }
  if (jsonMode) {
    request.response_format = { type: "json_object" };
  }

  const response = await client.chat.completions.create(request as never);
  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("模型返回为空");
  }
  return content;
}

/** 429 时等一等再试（智谱免费模型连续两次识图就会限流，2026-10-04 实测）。次数和文字模型共用 MEMO_MODEL_MAX_RETRIES */
function visionRetries(): number {
  const raw = Number(process.env.MEMO_MODEL_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(5, Math.floor(raw)) : 1;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>, retries = visionRetries()): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= retries) throw error;
      const waitMs = [1_500, 4_000, 8_000, 12_000, 16_000][attempt] ?? 16_000;
      console.info(JSON.stringify({ event: "vision_rate_limited_retry", attempt: attempt + 1, waitMs }));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export async function callVision({
  imageDataUrl,
  systemPrompt,
  userText,
  imageDetail = "high",
  model = defaultVisionModel(),
  enableThinking = process.env.LLM_THINKING === "true",
  jsonMode = process.env.LLM_JSON_MODE === "true",
  timeoutMs = 55_000,
}: CallVisionOptions): Promise<string> {
  const startedAt = Date.now();
  const userContent = imageDataUrl
    ? [
        { type: "text" as const, text: userText },
        {
          type: "image_url" as const,
          image_url: { url: imageDataUrl, detail: imageDetail },
        },
      ]
    : [{ type: "text" as const, text: userText }];

  const provider = visionProvider();
  const models = getVisionModels(model, provider);
  let lastError: unknown = null;

  for (const candidate of models) {
    const candidateTimeout =
      candidate === model ? timeoutMs : Math.min(timeoutMs, 20_000);
    const client = getClient(candidateTimeout, provider);
    try {
      const content = await withRateLimitRetry(() =>
        requestVision(
          client,
          candidate,
          userContent,
          systemPrompt,
          enableThinking,
          jsonMode,
          provider,
        ),
      );
      console.info(
        JSON.stringify({
          event: "vision_complete",
          model: candidate,
          durationMs: Date.now() - startedAt,
          responseLength: content.length,
        }),
      );
      return content;
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) {
        throw error;
      }
      console.info(
        JSON.stringify({
          event: "vision_rate_limited_fallback",
          failedModel: candidate,
        }),
      );
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `模型服务限流，已尝试 ${models.length} 个模型：${lastError.message}`
      : "模型服务限流，请稍后再试",
  );
}

export async function callOmni({
  frames,
  frameTimes,
  audioDataUrl,
  systemPrompt,
  userText,
  model = process.env.OMNI_MODEL ?? "qwen3.5-omni-plus",
  timeoutMs = 55_000,
}: CallOmniOptions): Promise<string> {
  const startedAt = Date.now();
  const client = getClient(timeoutMs);
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `${userText}\n帧时间：${frameTimes.map((time) => time.toFixed(1)).join(" / ")} 秒`,
    },
    ...frames.map((url) => ({
      type: "image_url",
      image_url: { url, detail: "high" },
    })),
  ];

  // 没有音轨就不要放 input_audio 这一块：
  // 很多视觉模型（比如 gpt-4o）根本不接受这种内容块，带上去整条请求会被拒。
  if (audioDataUrl) {
    content.push({
      type: "input_audio",
      input_audio: { data: audioDataUrl, format: "wav" },
    });
  }

  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    temperature: 0.2,
    max_tokens: 2400,
    stream: true,
  };
  // modalities 是 omni / audio 类模型才认的参数。
  // 纯视觉模型（gpt-4o 等）带上它可能整条请求被拒，所以只在真的送了音频时才加。
  if (audioDataUrl) request.modalities = ["text"];

  const stream = (await client.chat.completions.create(
    request as never,
  )) as unknown as AsyncIterable<{
    choices?: Array<{ delta?: { content?: unknown } }>;
  }>;

  let result = "";
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string") result += delta;
    if (result.length > 20_000) {
      throw new Error("模型返回内容过长");
    }
  }
  if (!result.trim()) throw new Error("模型返回为空");

  console.info(
    JSON.stringify({
      event: "omni_complete",
      model,
      durationMs: Date.now() - startedAt,
      frameCount: frames.length,
      responseLength: result.length,
    }),
  );
  return result;
}
