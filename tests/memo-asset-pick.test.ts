// 以声定图的多选一接口（外部设备接入工单 v2 Gate 2）：识图模型用桩，不打网络
import { afterEach, describe, expect, it, vi } from "vitest";

const callVision = vi.fn();
vi.mock("@/lib/llm", () => ({
  callVision: (...args: unknown[]) => callVision(...args),
  defaultVisionModel: () => "glm-4.6v-flash",
  visionProvider: () => "zhipu",
}));

const { POST } = await import("@/app/api/memo/asset-pick/route");

const SHEET = `data:image/jpeg;base64,${"A".repeat(200)}`;
function request(body: Record<string, unknown>) {
  return new Request("https://yujianji.example.com/api/memo/asset-pick", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": "dev_test_asset_pick_00001" },
    body: JSON.stringify({ runId: "v_2026-10-02_abc", dayKey: "2026-10-02", momentId: "ses_x:w0:m0", quote: "这个塔的砖是粉色的", trigger: "粉色的塔", count: 3, sheet: SHEET, ...body }),
  });
}

afterEach(() => callVision.mockReset());

describe("asset-pick", () => {
  it("选中的编号原样返回，并带过程记录", async () => {
    callVision.mockResolvedValue('{"pick": 2, "reason": "第二张是粉色砖塔"}');
    const res = await POST(request({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pick).toBe(2);
    expect(json.trace.scope).toBe("match");
    expect(callVision.mock.calls[0][0].userText).toContain("这个塔的砖是粉色的");
  });

  it("编号超出候选数、或回答解析不了 → 都按不选处理（留白好过配错图）", async () => {
    callVision.mockResolvedValue('{"pick": 3, "reason": "x"}');
    expect((await (await POST(request({ count: 2 }))).json()).pick).toBe(0);
    callVision.mockResolvedValue("我觉得是第二张");
    const res = await (await POST(request({}))).json();
    expect(res.pick).toBe(0);
    expect(res.trace.outcome).toBe("degraded");
  });

  it("识图服务拒绝调用 → 503 VISION_UNAVAILABLE，单独说清楚", async () => {
    callVision.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const res = await POST(request({}));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("VISION_UNAVAILABLE");
  });

  it("只收 2–3 张、JPEG 拼图", async () => {
    expect((await POST(request({ count: 1 }))).status).toBe(400);
    expect((await POST(request({ sheet: "data:image/png;base64,AAAA" }))).status).toBe(400);
    expect(callVision).not.toHaveBeenCalled();
  });
});
