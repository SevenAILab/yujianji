import { describe, expect, it } from "vitest";
import { distanceBetween, formatDistance, riskLevelForHealth, summarizeTrack } from "../src/lib/trip";
import type { HealthSnapshot, TrackPoint } from "../src/lib/types";

const point = (lat: number, lng: number, altitude?: number): TrackPoint => ({
  timestamp: new Date().toISOString(),
  lat,
  lng,
  altitude,
});

describe("trip calculations", () => {
  it("calculates geographic distance and elevation gain", () => {
    const points = [point(22.540, 114.060, 40), point(22.541, 114.061, 52), point(22.542, 114.062, 48)];
    const summary = summarizeTrack(points);
    expect(distanceBetween(points[0], points[1])).toBeGreaterThan(100);
    expect(summary.distanceMeters).toBeGreaterThan(250);
    expect(summary.elevationGainMeters).toBe(12);
    expect(formatDistance(summary.distanceMeters)).toMatch(/m|km/);
  });

  it("raises risk when recent vitals are concerning", () => {
    const snapshot = (heartRate: number, bloodOxygen: number): HealthSnapshot => ({
      timestamp: new Date().toISOString(), heartRate, bloodOxygen, source: "manual",
    });
    expect(riskLevelForHealth([snapshot(110, 98)])).toBe("low");
    expect(riskLevelForHealth([snapshot(150, 93)])).toBe("medium");
    expect(riskLevelForHealth([snapshot(170, 88)])).toBe("high");
  });
});
