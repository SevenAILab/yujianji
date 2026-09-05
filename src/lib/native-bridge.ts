import { Capacitor, registerPlugin } from "@capacitor/core";
import { z } from "zod";
import type { HealthSnapshot } from "./types";

const metricSchema = z.enum(["heartRate", "bloodOxygen", "steps"]);
export const nativeSampleSchema = z.object({
  id: z.string().min(1).max(300),
  metric: metricSchema,
  value: z.number().finite(),
  timestamp: z.iso.datetime({ offset: true }),
  endTimestamp: z.iso.datetime({ offset: true }).optional(),
  originId: z.string().min(1).max(300),
  originName: z.string().max(200),
  provider: z.enum(["health-connect", "healthkit"]),
}).superRefine((sample, context) => {
  const maximum = sample.metric === "heartRate" ? 300 : sample.metric === "bloodOxygen" ? 100 : 1_000_000;
  if (sample.value < 0 || sample.value > maximum || (sample.metric === "heartRate" && sample.value === 0)) {
    context.addIssue({ code: "custom", message: "健康记录数值超出有效范围" });
  }
  if (sample.metric === "steps" && (!Number.isInteger(sample.value) || !sample.endTimestamp)) {
    context.addIssue({ code: "custom", message: "步数必须包含整数和区间结束时间" });
  }
  if (sample.endTimestamp && Date.parse(sample.endTimestamp) < Date.parse(sample.timestamp)) {
    context.addIssue({ code: "custom", message: "记录时间范围无效" });
  }
});

export type NativeHealthSample = z.infer<typeof nativeSampleSchema>;
export type HealthMetric = z.infer<typeof metricSchema>;

export interface HealthBridgePlugin {
  status(): Promise<{ available: boolean; provider: "health-connect" | "healthkit"; reason?: string }>;
  requestAccess(): Promise<{ requested: boolean; granted: HealthMetric[] | null }>;
  readSamples(options: { from: string; to: string }): Promise<{ samples: NativeHealthSample[]; truncated: boolean }>;
}

const plugin = registerPlugin<HealthBridgePlugin>("YujianjiHealth");

export function nativePlatform(): "android" | "ios" | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios" ? platform : null;
}

export function getHealthBridge(): HealthBridgePlugin | null {
  return nativePlatform() ? plugin : null;
}

export function parseNativeSamples(input: unknown, from: string, to: string): NativeHealthSample[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 86_400_000) {
    throw new Error("每次同步范围必须在 24 小时以内");
  }
  const samples = nativeSampleSchema.array().max(20_000).parse(input);
  const unique = new Map<string, NativeHealthSample>();
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    if (timestamp < start || Date.parse(sample.endTimestamp ?? sample.timestamp) > end) continue;
    unique.set(sampleKey(sample), sample);
  }
  return [...unique.values()].sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp));
}

export function sampleKey(sample: NativeHealthSample): string {
  return JSON.stringify([sample.provider, sample.originId, sample.id, sample.metric, sample.timestamp]);
}

export function toHealthSnapshot(sample: NativeHealthSample): HealthSnapshot {
  return {
    timestamp: sample.timestamp,
    [sample.metric]: sample.value,
    source: "health-provider",
    sampleId: sampleKey(sample),
    originId: sample.originId,
    originName: sample.originName,
    provider: sample.provider,
    endTimestamp: sample.endTimestamp,
  };
}

export function latestSample(samples: NativeHealthSample[], metric: HealthMetric, now = Date.now()): NativeHealthSample | undefined {
  return samples.filter((sample) => sample.metric === metric && Date.parse(sample.timestamp) <= now)
    .sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))[0];
}
