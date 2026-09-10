import { z } from "zod";
import { extractJsonObject } from "./json";

const replySchema = z.object({ reply: z.string().min(1) });
const MAX_REPLY_CHARS = 45;

export type ReplyViolation = "parse" | "empty" | "too_long" | "question" | "latin";

export class ReplyValidationError extends Error {
  readonly reason: ReplyViolation;

  constructor(reason: ReplyViolation, message: string) {
    super(message);
    this.name = "ReplyValidationError";
    this.reason = reason;
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^["“”「」]+|["“”「」]+$/g, "").trim();
}

function splitSentences(text: string): string[] {
  return (text.match(/[^。！!？?]+[。！!？?]?/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

const hasLatin = (text: string) => /[A-Za-z]/.test(text);
const endsWithQuestion = (text: string) => /[?？]$/.test(text);

/**
 * flash 类模型爱多说一句（「…。顺便一提，…」），或者在结尾补一个问题。
 * 前面那句往往本身就是合格的回应；整条丢掉，用户认真写的回答就「掉在地上」了。
 *
 * 所以按句子往回收：从开头累加，遇到夹英文的句子或超长就停，
 * 取最后一个不以问号结尾的前缀。用的全是模型自己写的原句，不补写、不改字。
 */
export function salvageReply(text: string): string | null {
  let best: string | null = null;
  let acc = "";
  for (const sentence of splitSentences(text)) {
    if (hasLatin(sentence)) break;
    const next = acc + sentence;
    if (next.length > MAX_REPLY_CHARS) break;
    acc = next;
    if (!endsWithQuestion(acc)) best = acc;
  }
  return best;
}

export function parseReplyResult(raw: string): string {
  let parsed: z.infer<typeof replySchema>;
  try {
    parsed = replySchema.parse(extractJsonObject(raw));
  } catch {
    throw new ReplyValidationError("parse", "回应不是合法的 JSON");
  }

  let reply = stripQuotes(parsed.reply);
  if (!reply) throw new ReplyValidationError("empty", "模型返回空回应");

  if (reply.length > MAX_REPLY_CHARS || endsWithQuestion(reply) || hasLatin(reply)) {
    const salvaged = salvageReply(reply);
    if (!salvaged) {
      if (hasLatin(reply)) throw new ReplyValidationError("latin", "回应里夹了英文");
      if (reply.length > MAX_REPLY_CHARS) {
        throw new ReplyValidationError("too_long", `回应超过${MAX_REPLY_CHARS}字`);
      }
      throw new ReplyValidationError("question", "回应以问题结尾");
    }
    reply = salvaged;
  }
  return reply;
}
