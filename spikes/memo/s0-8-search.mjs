// S0 第 8 项：enable_search。3 个实体（一座桥、一道菜、一栋建筑）是否返回合理事实。
// 同时确认兼容模式下参数怎么透传：AI SDK providerOptions（会被展开进请求体）vs openai SDK 直接加字段。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import OpenAI from "openai";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const model = process.argv[2] ?? "qwen3.5-plus";
const entities = [
  { entity: "伦敦塔桥", question: "哪一年建成？是什么类型的桥？" },
  { entity: "肉夹馍", question: "起源于哪里？主要做法？" },
  { entity: "深圳平安金融中心", question: "多高？哪年落成？" },
];
const system = "你是事实补充助手。用一句 ≤60 字的中文陈述回答，只写事实，不写观点；不确定就回答「未查到可靠信息」。";

const provider = createOpenAICompatible({ name: "dashscope", baseURL: env.baseURL, apiKey: env.apiKey, includeUsage: true });
const client = new OpenAI({ apiKey: env.apiKey, baseURL: env.baseURL, timeout: 20_000, maxRetries: 0 });

for (const e of entities) {
  const prompt = `实体：${e.entity}\n问题：${e.question}`;
  let t0 = Date.now();
  try {
    const r = await generateText({
      model: provider.chatModel(model),
      system, prompt, maxRetries: 0, abortSignal: AbortSignal.timeout(20_000),
      providerOptions: { dashscope: { enable_search: true, enable_thinking: false, search_options: { forced_search: true } } },
    });
    console.log(JSON.stringify({ via: "ai-sdk", entity: e.entity, ms: Date.now() - t0, text: r.text, in: r.usage.inputTokens, out: r.usage.outputTokens }));
  } catch (error) {
    console.log(JSON.stringify({ via: "ai-sdk", entity: e.entity, error: String(error?.message ?? error).slice(0, 200) }));
  }
  t0 = Date.now();
  try {
    const r = await client.chat.completions.create({
      model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      enable_search: true, enable_thinking: false, search_options: { forced_search: true },
    });
    console.log(JSON.stringify({ via: "openai-sdk", entity: e.entity, ms: Date.now() - t0, text: r.choices[0]?.message?.content, in: r.usage?.prompt_tokens, out: r.usage?.completion_tokens }));
  } catch (error) {
    console.log(JSON.stringify({ via: "openai-sdk", entity: e.entity, error: String(error?.message ?? error).slice(0, 200) }));
  }
  // 对照：不开搜索
  t0 = Date.now();
  const r0 = await generateText({ model: provider.chatModel(model), system, prompt, maxRetries: 0, providerOptions: { dashscope: { enable_thinking: false } } });
  console.log(JSON.stringify({ via: "no-search", entity: e.entity, ms: Date.now() - t0, text: r0.text, in: r0.usage.inputTokens }));
}
