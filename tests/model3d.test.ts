import { afterEach, describe, expect, it, vi } from "vitest";
import { modelable } from "../src/lib/model3d/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const base = { id: "a", photo: "data:image/jpeg;base64,AAAA", category: "animal", isSeed: false, ai: { verdict: "first" }, createdAt: "2026-09-24T00:00:00.000Z", mediaKind: "standard" } as const;

describe("照片 → 3D 模型", () => {
  it("只给自己拍的、有主体的初见建模：示例、重逢、风景、全景都不建", () => {
    expect(modelable(base as never)).toBe(true);
    expect(modelable({ ...base, isSeed: true } as never)).toBe(false);
    expect(modelable({ ...base, ai: { verdict: "reunion" } } as never)).toBe(false);
    expect(modelable({ ...base, category: "landscape" } as never)).toBe(false);
    expect(modelable({ ...base, category: "sky" } as never)).toBe(false);
    expect(modelable({ ...base, mediaKind: "panorama" } as never)).toBe(false);
    expect(modelable({ ...base, photo: "/seed/cat.jpg" } as never)).toBe(false);
  });

  it("没配 Tripo 密钥时直接说没开通，不去碰额度和上游", async () => {
    vi.stubEnv("TRIPO_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await import("../src/app/api/model3d/jobs/route");
    const response = await POST(new Request("http://localhost/api/model3d/jobs", { method: "POST", headers: { "x-device-id": "dev_abcdefghijklmnop" }, body: "{}" }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("MODEL3D_OFF");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("查进度和取模型只认本设备的任务", async () => {
    const { POST: status } = await import("../src/app/api/model3d/status/route");
    const noDevice = await status(new Request("http://localhost/api/model3d/status", { method: "POST", body: JSON.stringify({ taskIds: ["x"] }) }));
    expect(noDevice.status).toBe(401);
    const { POST: model } = await import("../src/app/api/model3d/model/route");
    const unknown = await model(new Request("http://localhost/api/model3d/model", { method: "POST", headers: { "x-device-id": "dev_abcdefghijklmnop" }, body: JSON.stringify({ taskId: "00000000-0000-0000-0000-000000000000" }) }));
    expect(unknown.status).toBe(404);
  });
});
