import type { AgentTrace } from "../memo/types";

export type AgentErrorCode =
  | "AGENT_BUDGET_EXCEEDED"
  | "INVALID_MODEL_OUTPUT"
  | "BUDGET_EXCEEDED"
  | "MODEL_ERROR"
  | "MODEL_RATE_LIMITED";

const STATUS: Record<AgentErrorCode, number> = {
  AGENT_BUDGET_EXCEEDED: 504,
  INVALID_MODEL_OUTPUT: 502,
  BUDGET_EXCEEDED: 503,
  MODEL_ERROR: 502,
  MODEL_RATE_LIMITED: 429,
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly limitHit?: "steps" | "tool_calls" | "deadline";
  trace?: AgentTrace;

  constructor(code: AgentErrorCode, message: string, opts: { limitHit?: "steps" | "tool_calls" | "deadline" } = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.limitHit = opts.limitHit;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return name === "AbortError" || name === "TimeoutError" || message.includes("aborted") || message.includes("timeout");
}

/** 把 AI SDK / 网络层的异常归一成我们的错误码 */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (isAbort(error)) return new AgentError("AGENT_BUDGET_EXCEEDED", "整轮截止时间到了", { limitHit: "deadline" });
  const status = (error as { statusCode?: number; lastError?: { statusCode?: number } })?.statusCode
    ?? (error as { lastError?: { statusCode?: number } })?.lastError?.statusCode;
  if (status === 429) return new AgentError("MODEL_RATE_LIMITED", "模型服务限流");
  const cause = (error as { lastError?: unknown })?.lastError;
  if (cause && isAbort(cause)) return new AgentError("AGENT_BUDGET_EXCEEDED", "整轮截止时间到了", { limitHit: "deadline" });
  return new AgentError("MODEL_ERROR", error instanceof Error ? error.message.slice(0, 200) : "模型调用失败");
}
