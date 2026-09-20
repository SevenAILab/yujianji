// S0 第 9 项：花钱前先 ping。最小请求确认 key、base、模型名都通。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describeEnv, loadEnv } from "./env.mjs";

const env = loadEnv();
console.log("env", describeEnv(env));

const provider = createOpenAICompatible({ name: "dashscope", baseURL: env.baseURL, apiKey: env.apiKey });
const models = (process.argv[2] ?? "qwen3.5-flash,qwen3.5-plus,qwen3-max").split(",");

for (const id of models) {
  const t0 = Date.now();
  try {
    const result = await generateText({
      model: provider.chatModel(id),
      prompt: "只回复两个字：收到",
      maxOutputTokens: 20,
      maxRetries: 0,
      providerOptions: { dashscope: { enable_thinking: false } },
    });
    console.log(JSON.stringify({ model: id, ok: true, ms: Date.now() - t0, text: result.text, usage: { in: result.usage.inputTokens, out: result.usage.outputTokens }, finish: result.finishReason }));
  } catch (error) {
    console.log(JSON.stringify({ model: id, ok: false, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 300), status: error?.statusCode }));
  }
}
