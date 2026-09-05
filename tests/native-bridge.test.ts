import { describe, expect, it } from "vitest";
import { getHealthBridge, latestSample, parseNativeSamples, sampleKey, toHealthSnapshot, type NativeHealthSample } from "../src/lib/native-bridge";

const from = "2026-09-05T09:00:00Z";
const to = "2026-09-05T10:00:00Z";
const sample: NativeHealthSample = {
  id: "record-1", metric: "heartRate", value: 92, timestamp: "2026-09-05T09:30:00Z",
  originId: "actual.vendor.application", originName: "Actual source", provider: "health-connect",
};

describe("native health boundary", () => {
  it("does not invent a native bridge in ordinary Web", () => {
    expect(getHealthBridge()).toBeNull();
  });
  it("deduplicates by provider, origin, record, metric and timestamp", () => {
    const otherOrigin = { ...sample, originId: "another.source" };
    expect(parseNativeSamples([sample, sample, otherOrigin], from, to)).toHaveLength(2);
    expect(sampleKey(sample)).not.toBe(sampleKey(otherOrigin));
  });
  it("rejects invalid oxygen, dates, future ranges and large batches", () => {
    expect(() => parseNativeSamples([{ ...sample, metric: "bloodOxygen", value: 101 }], from, to)).toThrow();
    expect(() => parseNativeSamples([{ ...sample, timestamp: "not-a-date" }], from, to)).toThrow();
    expect(() => parseNativeSamples([], to, from)).toThrow();
    expect(() => parseNativeSamples([], from, "2026-09-07T10:00:00Z")).toThrow();
    expect(() => parseNativeSamples(Array(20_001).fill(sample), from, to)).toThrow();
  });
  it("keeps measurement timestamps, source and missing fields intact", () => {
    const snapshot = toHealthSnapshot(sample);
    expect(snapshot.timestamp).toBe(sample.timestamp);
    expect(snapshot.originId).toBe(sample.originId);
    expect(snapshot.bloodOxygen).toBeUndefined();
    expect(snapshot.source).toBe("health-provider");
  });
  it("does not attribute out-of-range historical records to a trip", () => {
    expect(parseNativeSamples([{ ...sample, timestamp: "2026-09-04T09:30:00Z" }], from, to)).toEqual([]);
  });
  it("keeps zero steps but requires a valid interval", () => {
    const steps = { ...sample, metric: "steps", value: 0, endTimestamp: to };
    expect(parseNativeSamples([steps], from, to)[0].value).toBe(0);
    expect(() => parseNativeSamples([{ ...steps, endTimestamp: undefined }], from, to)).toThrow();
  });
  it("selects latest independently for each metric and excludes future samples", () => {
    const oxygen: NativeHealthSample = { ...sample, id: "oxygen", metric: "bloodOxygen", value: 97 };
    expect(latestSample([sample, oxygen], "bloodOxygen", Date.parse(to))).toEqual(oxygen);
    expect(latestSample([sample], "heartRate", Date.parse(from))).toBeUndefined();
  });
});
