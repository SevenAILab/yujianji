import { z } from "zod";
import { extractJsonObject } from "./json";

const replySchema = z.object({ reply: z.string().min(1) });

export function parseReplyResult(raw: string): string {
  const parsed = replySchema.parse(extractJsonObject(raw));
  const reply = parsed.reply.replace(/^["“”「」]+|["“”「」]+$/g, "").trim();
  if (!reply) throw new Error("模型返回空回应");
  if (reply.length > 45) throw new Error("模型回应超过45字");
  if (/[?？]$/.test(reply)) throw new Error("模型回应不应继续提问");
  if (/[A-Za-z]/.test(reply)) throw new Error("模型回应必须使用中文");
  return reply;
}
