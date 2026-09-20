"use client";

import { apiUrl } from "../../app-mode";

export interface Position {
  lat: number;
  lng: number;
  accuracyM: number;
}

export function samplePosition(timeoutMs = 8_000): Promise<Position | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** 查地名走遇见集已有的 /api/reverse-geocode（固定流程，不算 Agent 工具） */
export async function reverseGeocode(position: Position): Promise<{ place: string; country?: string } | null> {
  try {
    const res = await fetch(apiUrl("/api/reverse-geocode"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: position.lat, lng: position.lng }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { place?: string; country?: string };
    return json.place ? { place: json.place, country: json.country } : null;
  } catch {
    return null;
  }
}
