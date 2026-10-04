// 外部设备接入工单 v2 Gate 0：智谱可切换、排队、额度错误分类
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, toAgentError } from "@/lib/agent/errors";
import { acquireModelSlot, limiterState } from "@/lib/agent/limiter";
import { tokenCostYuan } from "@/lib/agent/pricing";
import { languageModelFor, mainProvider, memoApiKey, memoBaseUrl, modelIdFor } from "@/lib/agent/provider";
import { defaultVisionModel, visionProvider } from "@/lib/llm";
import { isQuotaError } from "@/lib/memo/server/bailian";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("文字模型服务商切换", () => {
  it("默认是千问，行为不变", () => {
    vi.stubEnv("MEMO_LLM_PROVIDER", "");
    vi.stubEnv("MEMO_AGENT_MODEL", "qwen3.5-plus-2026-04-20");
    expect(mainProvider()).toBe("dashscope");
    expect(modelIdFor("agent")).toBe("qwen3.5-plus-2026-04-20");
  });

  it("切到智谱：凭证、地址、模型都换，千问的 MEMO_*_MODEL 不再生效", () => {
    vi.stubEnv("MEMO_LLM_PROVIDER", "zhipu");
    vi.stubEnv("ZHIPU_API_KEY", "zk-test");
    vi.stubEnv("MEMO_AGENT_MODEL", "qwen3.5-plus-2026-04-20");
    vi.stubEnv("ZHIPU_BASE_URL", "");
    expect(mainProvider()).toBe("zhipu");
    expect(memoApiKey()).toBe("zk-test");
    expect(memoBaseUrl()).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(modelIdFor("agent")).toBe("glm-4.5-flash");
    vi.stubEnv("ZHIPU_TEXT_MODEL", "glm-4.7-flash");
    expect(modelIdFor("writer")).toBe("glm-4.7-flash");
    vi.stubEnv("ZHIPU_TRIAGE_MODEL", "glm-4-flash-250414");
    expect(modelIdFor("triage")).toBe("glm-4-flash-250414");
  });

  it("关思考的写法按服务商区分", () => {
    vi.stubEnv("MEMO_LLM_PROVIDER", "zhipu");
    vi.stubEnv("ZHIPU_API_KEY", "zk-test");
    expect(languageModelFor("agent").providerOptions).toEqual({ zhipu: { thinking: { type: "disabled" } } });
    vi.stubEnv("MEMO_LLM_PROVIDER", "dashscope");
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test");
    expect(languageModelFor("agent").providerOptions).toEqual({ dashscope: { enable_thinking: false } });
  });

  it("智谱没配密钥时给出明确错误", () => {
    vi.stubEnv("MEMO_LLM_PROVIDER", "zhipu");
    vi.stubEnv("ZHIPU_API_KEY", "");
    expect(() => languageModelFor("agent")).toThrow(/ZHIPU_API_KEY/);
  });

  it("智谱免费模型记 0 元", () => {
    expect(tokenCostYuan("glm-4.5-flash", 10_000, 2_000)).toEqual({ yuan: 0, estimated: false });
    expect(tokenCostYuan("glm-4.6v-flash", 10_000, 2_000).yuan).toBe(0);
  });
});

describe("识图服务商切换", () => {
  it("默认千问，切到智谱用 glm-4.6v-flash", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("VISION_MODEL", "qwen3-vl-plus");
    expect(visionProvider()).toBe("dashscope");
    expect(defaultVisionModel()).toBe("qwen3-vl-plus");
    vi.stubEnv("VISION_PROVIDER", "zhipu");
    expect(defaultVisionModel()).toBe("glm-4.6v-flash");
  });
});

describe("模型调用排队", () => {
  it("不限并发时直接放行", async () => {
    const release = await acquireModelSlot(0);
    release();
    expect(limiterState()).toEqual({ active: 0, queued: 0 });
  });

  it("并发 1：第二个排队，第一个释放后接上", async () => {
    const order: string[] = [];
    const first = await acquireModelSlot(1, 5_000);
    order.push("first");
    const secondPromise = acquireModelSlot(1, 5_000).then((release) => {
      order.push("second");
      return release;
    });
    expect(limiterState()).toEqual({ active: 1, queued: 1 });
    first();
    first(); // 重复释放无副作用
    const second = await secondPromise;
    expect(order).toEqual(["first", "second"]);
    expect(limiterState()).toEqual({ active: 1, queued: 0 });
    second();
    expect(limiterState()).toEqual({ active: 0, queued: 0 });
  });

  it("排队超时按限流失败", async () => {
    const holder = await acquireModelSlot(1, 5_000);
    await expect(acquireModelSlot(1, 20)).rejects.toMatchObject({ code: "MODEL_RATE_LIMITED" });
    holder();
    expect(limiterState()).toEqual({ active: 0, queued: 0 });
  });
});

describe("失败分类", () => {
  it("401 / 403 是服务不可用，不是网络抖动", () => {
    expect(toAgentError({ statusCode: 403, message: "forbidden" }).code).toBe("MODEL_UNAVAILABLE");
    expect(toAgentError({ statusCode: 429 }).code).toBe("MODEL_RATE_LIMITED");
    expect(toAgentError(new AgentError("MODEL_ERROR", "x")).code).toBe("MODEL_ERROR");
  });

  it("百炼额度类错误码", () => {
    expect(isQuotaError("AllocationQuota.FreeTierOnly")).toBe(true);
    expect(isQuotaError("Arrearage")).toBe(true);
    expect(isQuotaError("InvalidParameter")).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("隐私政策里点名的服务商跟着配置走", () => {
  it("识图和判断写作分别按各自的服务商点名", async () => {
    const { textProviderLabel, visionProviderLabel } = await import("@/lib/model-provider");
    vi.stubEnv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1");
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("MEMO_LLM_PROVIDER", "");
    vi.stubEnv("MEMO_BASE_URL", "");
    expect(visionProviderLabel()).toBe("阿里云百炼");
    expect(textProviderLabel()).toBe("阿里云百炼");
    vi.stubEnv("VISION_PROVIDER", "zhipu");
    vi.stubEnv("MEMO_LLM_PROVIDER", "zhipu");
    expect(visionProviderLabel()).toBe("智谱 AI");
    expect(textProviderLabel()).toBe("智谱 AI");
  });
});
