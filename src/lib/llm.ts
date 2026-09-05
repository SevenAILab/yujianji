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
  audioDataUrl: string;
  systemPrompt: string;
  userText: string;
  model?: string;
  timeoutMs?: number;
}

function getClient(timeoutMs = 55_000): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const baseURL =
    process.env.DASHSCOPE_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";

  if (!apiKey) {
    throw new Error("缺少 DASHSCOPE_API_KEY，请配置 .env.local");
  }

  return new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });
}

export async function callVision({
  imageDataUrl,
  systemPrompt,
  userText,
  imageDetail = "high",
  model = process.env.VISION_MODEL ?? "qwen3-vl-plus",
  enableThinking = process.env.LLM_THINKING === "true",
  jsonMode = process.env.LLM_JSON_MODE === "true",
  timeoutMs = 55_000,
}: CallVisionOptions): Promise<string> {
  const startedAt = Date.now();
  const client = getClient(timeoutMs);
  const userContent = imageDataUrl
    ? [
        { type: "text" as const, text: userText },
        {
          type: "image_url" as const,
          image_url: { url: imageDataUrl, detail: imageDetail },
        },
      ]
    : [{ type: "text" as const, text: userText }];

  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 900,
    enable_thinking: enableThinking,
  };

  if (jsonMode) {
    request.response_format = { type: "json_object" };
  }

  const response = await client.chat.completions.create(
    request as never,
  );
  const content = response.choices[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("模型返回为空");
  }

  const message = response.choices[0]?.message as
    | { reasoning_content?: unknown }
    | undefined;
  console.info(
    JSON.stringify({
      event: "vision_complete",
      model,
      durationMs: Date.now() - startedAt,
      responseLength: content.length,
      reasoningPresent: Boolean(
        typeof message?.reasoning_content === "string" &&
          message.reasoning_content.trim(),
      ),
    }),
  );

  return content;
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
    {
      type: "input_audio",
      input_audio: { data: audioDataUrl, format: "wav" },
    },
  ];

  const stream = (await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    modalities: ["text"],
    temperature: 0.2,
    max_tokens: 2400,
    stream: true,
  } as never)) as unknown as AsyncIterable<{
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
