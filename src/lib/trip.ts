import type { HealthSnapshot, TrackPoint, Trip } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;

export function distanceBetween(first: Pick<TrackPoint, "lat" | "lng">, second: Pick<TrackPoint, "lat" | "lng">): number {
  const lat1 = (first.lat * Math.PI) / 180;
  const lat2 = (second.lat * Math.PI) / 180;
  const deltaLat = ((second.lat - first.lat) * Math.PI) / 180;
  const deltaLng = ((second.lng - first.lng) * Math.PI) / 180;
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function summarizeTrack(points: TrackPoint[]): Pick<Trip, "distanceMeters" | "elevationGainMeters" | "riskLevel"> {
  let distanceMeters = 0;
  let elevationGainMeters = 0;
  for (let index = 1; index < points.length; index += 1) {
    distanceMeters += distanceBetween(points[index - 1], points[index]);
    const previousAltitude = points[index - 1].altitude;
    const altitude = points[index].altitude;
    if (typeof previousAltitude === "number" && typeof altitude === "number" && altitude > previousAltitude) {
      elevationGainMeters += altitude - previousAltitude;
    }
  }
  return { distanceMeters, elevationGainMeters, riskLevel: riskLevelForHealth([]) };
}

export function riskLevelForHealth(snapshots: HealthSnapshot[]): Trip["riskLevel"] {
  const recent = snapshots.slice(-5);
  if (recent.some((snapshot) => (snapshot.bloodOxygen ?? 100) < 90 || (snapshot.heartRate ?? 0) > 165)) return "high";
  if (recent.some((snapshot) => (snapshot.bloodOxygen ?? 100) < 94 || (snapshot.heartRate ?? 0) > 145)) return "medium";
  return "low";
}

export function riskMessage(level: Trip["riskLevel"]): string {
  if (level === "high") return "建议立即停下、补水并评估是否需要求助";
  if (level === "medium") return "当前负荷偏高，建议降低速度并在安全点休息";
  return "当前指标平稳，继续保持补水与间歇休息";
}

export function demoTrackPoints(): TrackPoint[] {
  const startedAt = Date.now() - 8 * 60 * 1000;
  return Array.from({ length: 7 }, (_, index) => ({
    timestamp: new Date(startedAt + index * 80_000).toISOString(),
    lat: 22.540 + index * 0.00045,
    lng: 114.060 + index * 0.00058,
    altitude: 42 + index * 3,
    heading: 48,
    speed: 1.2,
  }));
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

export function formatDuration(startedAt: string, endedAt = new Date().toISOString()): string {
  const minutes = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
}
