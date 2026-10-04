// 模型按角色走环境变量（D6）。始终用 createOpenAICompatible 显式创建模型对象，不传字符串模型 id（避免走 @ai-sdk/gateway）。
//
// 主服务商可切换（外部设备接入工单 v2 Gate 0）：MEMO_LLM_PROVIDER=dashscope（默认）| zhipu。
// 智谱是实验项：百炼额度用完时手动切过去，切回只改环境变量。语音识别不受影响，永远走百炼（bailian.ts）。
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type AgentRole = "triage" | "agent" | "writer" | "verifier" | "reflect" | "fact";
export type LlmProvider = "dashscope" | "zhipu";

const ROLE_DEFAULTS: Record<AgentRole, [env: string, fallback: string]> = {
  triage: ["MEMO_TRIAGE_MODEL", "qwen3.5-flash"],
  agent: ["MEMO_AGENT_MODEL", "qwen3.5-plus"],
  writer: ["MEMO_WRITER_MODEL", "qwen3.5-plus"],
  verifier: ["MEMO_VERIFIER_MODEL", "qwen3.5-plus"],
  reflect: ["MEMO_REFLECT_MODEL", "qwen3-max"],
  fact: ["MEMO_FACT_MODEL", "qwen3.5-plus"],
};

export const DASHSCOPE_PROVIDER_NAME = "dashscope";
export const ZHIPU_PROVIDER_NAME = "zhipu";
const ZHIPU_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
/** 智谱免费文字模型。按角色覆盖：ZHIPU_<ROLE>_MODEL，统一覆盖：ZHIPU_TEXT_MODEL */
const ZHIPU_DEFAULT_TEXT_MODEL = "glm-4.5-flash";

// DashScope 不支持 json_schema 时 AI SDK 会退回 json_object 并每次打一条 warning（S0 第 7 项已知），关掉避免刷屏
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

/** "main" = 产品链路当前的主服务商；"dashscope" 是旧名字，等同 main（eval 脚本的 --provider dashscope 仍可用） */
type ProviderKind = "main" | "dashscope" | "eval";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProviderOpts = Record<string, Record<string, JsonValue>>;
const cache = new Map<string, ReturnType<typeof createOpenAICompatible>>();

export function structuredOutputsEnabled(): boolean {
  // S0 第 7 项：带工具时 DashScope 忽略 response_format，json_schema 与 json_object 表现一致；默认关
  return process.env.MEMO_STRUCTURED_OUTPUTS === "true";
}

export function mainProvider(): LlmProvider {
  return process.env.MEMO_LLM_PROVIDER?.trim() === "zhipu" ? "zhipu" : "dashscope";
}

/**
 * 单次 HTTP 请求的超时（与整轮截止时间并存）：整轮里有多步工具循环时，
 * 某一步的请求挂住不应该吃掉整轮剩下的时间。超时按网络错误处理，AI SDK 会按 maxRetries 重试。
 */
export function requestTimeoutMs(): number {
  return numberEnv("MEMO_REQUEST_TIMEOUT_MS", 60_000);
}

export function withRequestTimeout(timeoutMs = requestTimeoutMs()): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs), init?.signal].filter((s): s is AbortSignal => Boolean(s));
    return fetch(input, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
  };
}

function providerFor(kind: ProviderKind) {
  const structured = structuredOutputsEnabled();
  const resolved = kind === "eval" ? "eval" : mainProvider();
  const key = `${resolved}:${structured}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const provider =
    resolved === "eval"
      ? createOpenAICompatible({
          // 仅本机 eval 离线对比（Claude / GPT 的 OpenAI 兼容端点），不进产品链路
          name: "evalprovider",
          baseURL: process.env.MEMO_EVAL_BASE_URL ?? "",
          apiKey: process.env.MEMO_EVAL_API_KEY,
          supportsStructuredOutputs: structured,
          includeUsage: true,
          fetch: withRequestTimeout(),
        })
      : createOpenAICompatible({
          name: resolved === "zhipu" ? ZHIPU_PROVIDER_NAME : DASHSCOPE_PROVIDER_NAME,
          baseURL: memoBaseUrl(),
          apiKey: memoApiKey(),
          supportsStructuredOutputs: structured,
          includeUsage: true,
          fetch: withRequestTimeout(),
        });
  cache.set(key, provider);
  return provider;
}

export function modelIdFor(role: AgentRole, override?: string): string {
  if (override) return override;
  if (mainProvider() === "zhipu") {
    return process.env[`ZHIPU_${role.toUpperCase()}_MODEL`]?.trim() || process.env.ZHIPU_TEXT_MODEL?.trim() || ZHIPU_DEFAULT_TEXT_MODEL;
  }
  const [env, fallback] = ROLE_DEFAULTS[role];
  return process.env[env]?.trim() || fallback;
}

/** 各服务商"关掉思考"的写法不同：千问是 enable_thinking，智谱是 thinking.type */
function noThinkingOptions(provider: LlmProvider): ProviderOpts {
  return provider === "zhipu"
    ? { [ZHIPU_PROVIDER_NAME]: { thinking: { type: "disabled" } } }
    : { [DASHSCOPE_PROVIDER_NAME]: { enable_thinking: false } };
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
  const kind: ProviderKind = override?.provider ?? (process.env.MEMO_PROVIDER === "eval" ? "eval" : "main");
  if (kind !== "eval" && !memoApiKey()) {
    throw new Error(mainProvider() === "zhipu" ? "缺少 ZHIPU_API_KEY，请配置 .env.local" : "缺少 MEMO_API_KEY（或 DASHSCOPE_API_KEY），请配置 .env.local");
  }
  const modelId = modelIdFor(role, override?.modelId);
  return {
    model: providerFor(kind).chatModel(modelId),
    modelId,
    // 判断和写作都不需要思考，关掉省时间
    providerOptions: kind === "eval" ? {} : noThinkingOptions(mainProvider()),
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
 * 遇见手记的文字模型凭证。国内站的 DASHSCOPE_* 指向的是 Agnes（拍照链路用），
 * 而遇见手记的语音识别必须走百炼，所以优先读 MEMO_API_KEY / MEMO_BASE_URL，没配才回落。
 * 主服务商是智谱时用 ZHIPU_*；语音识别的凭证不经过这里（bailian.ts 自己读 MEMO_API_KEY）。
 */
export function memoApiKey(): string | undefined {
  if (mainProvider() === "zhipu") return process.env.ZHIPU_API_KEY?.trim() || undefined;
  return process.env.MEMO_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY;
}

export function memoBaseUrl(): string {
  if (mainProvider() === "zhipu") return process.env.ZHIPU_BASE_URL?.trim() || ZHIPU_DEFAULT_BASE_URL;
  return process.env.MEMO_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
}

export function memoKeySource(): "MEMO_API_KEY" | "DASHSCOPE_API_KEY" | "ZHIPU_API_KEY" | "missing" {
  if (mainProvider() === "zhipu") return process.env.ZHIPU_API_KEY?.trim() ? "ZHIPU_API_KEY" : "missing";
  if (process.env.MEMO_API_KEY?.trim()) return "MEMO_API_KEY";
  if (process.env.DASHSCOPE_API_KEY) return "DASHSCOPE_API_KEY";
  return "missing";
}

export function numberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
