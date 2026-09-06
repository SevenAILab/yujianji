import { afterEach, describe, expect, it, vi } from "vitest";
import { connectStandardHeartRate, supportsStandardBluetooth } from "../src/lib/devices";

function setup(fail = false) {
  const characteristic = Object.assign(new EventTarget(), {
    value: new DataView(new Uint8Array([0, 72]).buffer),
    startNotifications: vi.fn(async () => { if (fail) throw new Error("notifications failed"); return characteristic; }),
  });
  const device = Object.assign(new EventTarget(), {
    name: "Test heart rate",
    gatt: {
      connect: vi.fn(async () => ({ getPrimaryService: async () => ({ getCharacteristic: async () => characteristic }) })),
      disconnect: vi.fn(),
    },
  });
  const requestDevice = vi.fn(async () => device);
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { bluetooth: { requestDevice } });
  return { characteristic, device, requestDevice };
}
afterEach(() => vi.unstubAllGlobals());

describe("standard Bluetooth heart rate", () => {
  it("requires a secure supported environment", () => {
    setup();
    expect(supportsStandardBluetooth()).toBe(true);
    vi.stubGlobal("window", { isSecureContext: false });
    expect(supportsStandardBluetooth()).toBe(false);
  });
  it("filters heart-rate devices, decodes both formats and ignores malformed packets", async () => {
    const { characteristic, requestDevice } = setup();
    const onSample = vi.fn();
    const connection = await connectStandardHeartRate(onSample);
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: ["heart_rate"] }] });
    characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    expect(onSample).toHaveBeenLastCalledWith(expect.objectContaining({ heartRate: 72, source: "bluetooth-heart-rate" }));
    characteristic.value = new DataView(new Uint8Array([1, 4, 1]).buffer);
    characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    expect(onSample).toHaveBeenLastCalledWith(expect.objectContaining({ heartRate: 260 }));
    for (const bytes of [[], [1], [1, 4]]) {
      characteristic.value = new DataView(new Uint8Array(bytes).buffer);
      characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    }
    expect(onSample).toHaveBeenCalledTimes(2);
    connection.disconnect();
    characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    expect(onSample).toHaveBeenCalledTimes(2);
  });
  it("reports unexpected disconnect once and releases listeners", async () => {
    const { device, characteristic } = setup();
    const onSample = vi.fn();
    const onDisconnect = vi.fn();
    await connectStandardHeartRate(onSample, onDisconnect);
    device.dispatchEvent(new Event("gattserverdisconnected"));
    device.dispatchEvent(new Event("gattserverdisconnected"));
    characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onSample).not.toHaveBeenCalled();
  });
  it("cleans up failed subscription without leaking a connected device", async () => {
    const { device, characteristic } = setup(true);
    const onSample = vi.fn();
    await expect(connectStandardHeartRate(onSample)).rejects.toThrow("notifications failed");
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    expect(onSample).not.toHaveBeenCalled();
  });
  it("manual disconnect is idempotent and does not report an unexpected loss", async () => {
    const { device } = setup();
    const onDisconnect = vi.fn();
    const connection = await connectStandardHeartRate(vi.fn(), onDisconnect);
    connection.disconnect();
    connection.disconnect();
    device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
