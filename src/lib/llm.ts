import OpenAI from "openai";

interface CallVisionOptions {
  imageDataUrl?: string;
  systemPrompt: string;
  userText: string;
  model?: string;
  enableThinking?: boolean;
  jsonMode?: boolean;
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
          image_url: { url: imageDataUrl, detail: "high" as const },
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
    extra_body: { enable_thinking: enableThinking },
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

  console.info(
    JSON.stringify({
      event: "vision_complete",
      model,
      durationMs: Date.now() - startedAt,
      responseLength: content.length,
    }),
  );

  return content;
}
