import { APIConnectionTimeoutError, APIUserAbortError } from "openai";

export function isTimeoutLike(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true;
  if (error instanceof APIUserAbortError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("etimedout") ||
    message.includes("abort") ||
    message.includes("时间已用尽")
  );
}
