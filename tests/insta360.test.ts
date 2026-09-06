import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraAddress, captureFileUrl, captureInsta360, connectInsta360, disconnectInsta360 } from "../src/lib/insta360";

const address = "http://192.168.42.1";
const reply = (value: object) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => { disconnectInsta360(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Insta360 OSC capture", () => {
  it("limits camera addresses and returned files to the selected local camera", () => {
    expect(cameraAddress("192.168.42.1")).toBe(address);
    for (const value of ["https://example.com", "http://127.0.0.1", "http://192.168.42.1@evil.test", "http://192.168.999.1", "http://192.168.42.1/path"]) expect(() => cameraAddress(value)).toThrow();
    expect(captureFileUrl(address, { fileUrl: "/DCIM/new.jpg" }).origin).toBe(address);
    expect(() => captureFileUrl(address, { fileUrl: "http://evil.test/a.jpg" })).toThrow();
    expect(() => captureFileUrl(address, { fileUrl: "/DCIM/new.insp" })).toThrow();
    expect(() => captureFileUrl(address, { fileUrl: "/DCIM/new.jpg", _fileGroup: ["one", "two"] })).toThrow();
  });
  it("only connects after both info and state return valid camera responses", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ model: "Insta360 Test" })).mockResolvedValueOnce(reply({ state: { batteryLevel: .5 } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await connectInsta360(address)).toEqual({ name: "Insta360 Test", address });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([`${address}/osc/info`, `${address}/osc/state`]);
  });
  it("refuses to shoot when on-device stitching is unavailable", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/info")) return reply({ model: "Insta360 Test" });
      if (url.endsWith("/state")) return reply({ state: {} });
      const command = JSON.parse(init!.body as string);
      commands.push(command.name);
      return reply({ state: "done", results: { options: { photoStitchingSupport: ["none"] } } });
    }));
    await connectInsta360(address);
    await expect(captureInsta360(vi.fn())).rejects.toThrow("未提供机内拼接");
    expect(commands).toEqual(["camera.getOptions"]);
  });
  it("polls the current command ID, downloads only its result and never lists the camera album", async () => {
    vi.useFakeTimers();
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      requests.push({ url, body });
      if (url.endsWith("/info")) return reply({ model: "Insta360 Test" });
      if (url.endsWith("/state")) return reply({ state: { _latestFileUrl: "/old.jpg" } });
      if (body.name === "camera.getOptions") return reply({ state: "done", results: { options: { photoStitchingSupport: ["ondevice"] } } });
      if (body.name === "camera.setOptions") return reply({ state: "done" });
      if (body.name === "camera.takePicture") return reply({ state: "inProgress", id: "new-shot" });
      if (url.endsWith("/commands/status")) return reply({ state: "done", results: { fileUrl: `${address}/DCIM/new.jpg` } });
      return new Response(new Blob(["image"], { type: "image/jpeg" }));
    }));
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4096, height: 2048, close })));
    await connectInsta360(address);
    const pending = captureInsta360(vi.fn());
    await vi.runAllTimersAsync();
    const file = await pending;
    expect(file.name).toBe("new.jpg");
    expect(close).toHaveBeenCalled();
    expect(requests.find((request) => request.url.endsWith("/commands/status"))?.body).toEqual({ id: "new-shot" });
    expect(requests.some((request) => request.body.name === "camera.listFiles")).toBe(false);
    expect(requests.some((request) => request.url.endsWith("/old.jpg"))).toBe(false);
  });
});
