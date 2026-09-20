// S0 第 7 项诊断：Output.object 为什么解析失败 —— 打出最后一步的原始文本。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, NoObjectGeneratedError, Output, tool } from "ai";
import { z } from "zod";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const structured = process.argv[2] === "A";
const withTools = process.argv[3] !== "notools";
const provider = createOpenAICompatible({ name: "dashscope", baseURL: env.baseURL, apiKey: env.apiKey, supportsStructuredOutputs: structured });
const schema = z.object({ moments: z.array(z.object({ id: z.string(), decision: z.enum(["keep", "fold", "drop"]) })), sessionNotes: z.string() });
const steps = [];
try {
  const r = await generateText({
    model: provider.chatModel("qwen3.5-plus"),
    system: "判断每句话 keep/fold/drop。需要时先调用 recall_memory。最终输出 JSON：{\"moments\":[{\"id\":\"u1\",\"decision\":\"keep\"}],\"sessionNotes\":\"...\"}",
    prompt: JSON.stringify({ utterances: [{ id: "u1", text: "回酒店路上我还在想那座桥，一百多年了还在用。" }, { id: "u2", text: "晚饭吃什么？" }] }),
    ...(withTools ? { tools: { recall_memory: tool({ description: "查记忆", inputSchema: z.object({ query: z.string() }), execute: async () => ({ lines: ["m3|2026-09-23|伦敦·塔桥|keep|桥"] }) }) } } : {}),
    stopWhen: isStepCount(4),
    output: Output.object({ schema }),
    providerOptions: { dashscope: { enable_thinking: false } },
    onStepEnd: (s) => steps.push({ n: s.stepNumber, finish: s.finishReason, raw: s.rawFinishReason, tools: s.toolCalls.map((c) => c.toolName), text: s.text.slice(0, 300), warnings: s.warnings, reqBodyKeys: Object.keys(JSON.parse(typeof s.request.body === "string" ? s.request.body : "{}")) }),
  });
  console.log("OK", JSON.stringify(r.output));
} catch (e) {
  console.log("ERR", e?.name, NoObjectGeneratedError.isInstance(e) ? { text: e.text?.slice(0, 300), finishReason: e.finishReason, cause: String(e.cause).slice(0, 200) } : String(e).slice(0, 300));
}
console.log(JSON.stringify(steps, null, 1));
