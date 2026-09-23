import { describe, expect, it } from "vitest";
import { priceFor } from "../src/lib/agent/pricing";

describe("模型价格", () => {
  it("带日期的快照和通用名同价", () => {
    expect(priceFor("qwen3.5-plus-2026-04-20")).toEqual(priceFor("qwen3.5-plus"));
    expect(priceFor("qwen3.5-plus-2026-04-20").known).toBe(true);
  });

  it("没登记的模型仍按兜底价估算", () => {
    expect(priceFor("some-other-model").known).toBe(false);
  });
});
