// 模型按角色走环境变量（D6）。始终用 createOpenAICompatible 显式创建模型对象，不传字符串模型 id（避免走 @ai-sdk/gateway）。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type AgentRole = "triage" | "agent" | "writer" | "verifier" | "reflect" | "fact";

const ROLE_DEFAULTS: Record<AgentRole, [env: string, fallback: string]> = {
  triage: ["MEMO_TRIAGE_MODEL", "qwen3.5-flash"],
  agent: ["MEMO_AGENT_MODEL", "qwen3.5-plus"],
  writer: ["MEMO_WRITER_MODEL", "qwen3.5-plus"],
  verifier: ["MEMO_VERIFIER_MODEL", "qwen3.5-plus"],
  reflect: ["MEMO_REFLECT_MODEL", "qwen3-max"],
  fact: ["MEMO_FACT_MODEL", "qwen3.5-plus"],
};

export const DASHSCOPE_PROVIDER_NAME = "dashscope";

// DashScope 不支持 json_schema 时 AI SDK 会退回 json_object 并每次打一条 warning（S0 第 7 项已知），关掉避免刷屏
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

type ProviderKind = "dashscope" | "eval";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProviderOpts = Record<string, Record<string, JsonValue>>;
const cache = new Map<string, ReturnType<typeof createOpenAICompatible>>();

export function structuredOutputsEnabled(): boolean {
  // S0 第 7 项：带工具时 DashScope 忽略 response_format，json_schema 与 json_object 表现一致；默认关
  return process.env.MEMO_STRUCTURED_OUTPUTS === "true";
}

function providerFor(kind: ProviderKind) {
  const structured = structuredOutputsEnabled();
  const key = `${kind}:${structured}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const provider =
    kind === "eval"
      ? createOpenAICompatible({
          // 仅本机 eval 离线对比（Claude / GPT 的 OpenAI 兼容端点），不进产品链路
          name: "evalprovider",
          baseURL: process.env.MEMO_EVAL_BASE_URL ?? "",
          apiKey: process.env.MEMO_EVAL_API_KEY,
          supportsStructuredOutputs: structured,
          includeUsage: true,
        })
      : createOpenAICompatible({
          name: DASHSCOPE_PROVIDER_NAME,
          baseURL: memoBaseUrl(),
          apiKey: memoApiKey(),
          supportsStructuredOutputs: structured,
          includeUsage: true,
        });
  cache.set(key, provider);
  return provider;
}

export function modelIdFor(role: AgentRole, override?: string): string {
  if (override) return override;
  const [env, fallback] = ROLE_DEFAULTS[role];
  return process.env[env]?.trim() || fallback;
}

export function languageModelFor(role: AgentRole, override?: { modelId?: string; provider?: ProviderKind; instance?: LanguageModel }): {
  model: LanguageModel;
  modelId: string;
  providerOptions: ProviderOpts;
} {
  if (override?.instance) {
    // 单测注入 MockLanguageModel 用
    const id = typeof override.instance === "string" ? override.instance : override.instance.modelId;
    return { model: override.instance, modelId: override.modelId ?? id, providerOptions: {} };
  }
  const kind: ProviderKind = override?.provider ?? (process.env.MEMO_PROVIDER === "eval" ? "eval" : "dashscope");
  if (kind === "dashscope" && !memoApiKey()) {
    throw new Error("缺少 MEMO_API_KEY（或 DASHSCOPE_API_KEY），请配置 .env.local");
  }
  const modelId = modelIdFor(role, override?.modelId);
  return {
    model: providerFor(kind).chatModel(modelId),
    modelId,
    // 千问 3.5 默认可能开思考，判断和写作都不需要，关掉省时间
    providerOptions: kind === "dashscope" ? { [DASHSCOPE_PROVIDER_NAME]: { enable_thinking: false } } : {},
  };
}

export function withSearch(providerOptions: ProviderOpts): ProviderOpts {
  const current = providerOptions[DASHSCOPE_PROVIDER_NAME];
  if (!current) return providerOptions;
  return {
    ...providerOptions,
    [DASHSCOPE_PROVIDER_NAME]: { ...current, enable_search: true, search_options: { forced_search: true } },
  };
}

/**
 * 遇见手记的模型凭证。国内站的 DASHSCOPE_* 指向的是 Agnes（拍照链路用），
 * 而遇见手记的语音识别必须走百炼，所以优先读 MEMO_API_KEY / MEMO_BASE_URL，没配才回落。
 */
export function memoApiKey(): string | undefined {
  return process.env.MEMO_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY;
}

export function memoBaseUrl(): string {
  return process.env.MEMO_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
}

export function memoKeySource(): "MEMO_API_KEY" | "DASHSCOPE_API_KEY" | "missing" {
  if (process.env.MEMO_API_KEY?.trim()) return "MEMO_API_KEY";
  if (process.env.DASHSCOPE_API_KEY) return "DASHSCOPE_API_KEY";
  return "missing";
}

export function numberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
