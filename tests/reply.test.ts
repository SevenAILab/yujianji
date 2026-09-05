import { describe, expect, it } from "vitest";
import { PERSONA_PROMPT, REPLY_SYSTEM_PROMPT } from "../src/lib/prompt";
import { parseReplyResult } from "../src/lib/reply";

describe("reply contract", () => {
  it("继承统一人设并禁止追问", () => {
    expect(REPLY_SYSTEM_PROMPT).toContain(PERSONA_PROMPT);
    expect(REPLY_SYSTEM_PROMPT).toContain("禁止再提问");
  });

  it("拒绝超长回应", () => {
    expect(() => parseReplyResult(JSON.stringify({ reply: "字".repeat(46) }))).toThrow();
  });

  it("拒绝以问号结尾", () => {
    expect(() => parseReplyResult(JSON.stringify({ reply: "你当时蹲了多久？" }))).toThrow();
  });

  it("解析合法回应", () => {
    expect(parseReplyResult(JSON.stringify({ reply: "你说腿麻，看来这片叶子确实值得你蹲五分钟。" }))).toContain("腿麻");
  });
});
