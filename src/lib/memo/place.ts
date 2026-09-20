// 按句子时间定位地点：在采集时间轴上找离这句话最近的定位事件（spec v3 §4.2）。
import type { PlaceRef, TimelineEvent } from "./types";

export const PLACE_HIGH_MS = 5 * 60_000;
export const PLACE_MAX_MS = 30 * 60_000;

/**
 * 顺序：
 * 1. 会话地点已被用户确认（locked）→ 用它
 * 2. ±30 分钟内最近的定位事件 → ≤ 5 分钟 high，否则 medium
 * 3. 会话地点（未确认）→ 原样，置信度最多 low
 * 4. 都没有 → undefined（页面显示"地点未知"，不编）
 */
export function placeAt(events: TimelineEvent[], atIso: string, sessionPlace?: PlaceRef): PlaceRef | undefined {
  if (sessionPlace?.locked) return { ...sessionPlace, confidence: "high" };
  const at = new Date(atIso).getTime();
  let best: { event: TimelineEvent; distance: number } | null = null;
  for (const event of events) {
    if (event.kind !== "location" || event.lat === undefined || event.lng === undefined) continue;
    const distance = Math.abs(new Date(event.startAt).getTime() - at);
    if (distance > PLACE_MAX_MS) continue;
    if (!best || distance < best.distance) best = { event, distance };
  }
  if (best) {
    return {
      name: best.event.placeName ?? `${best.event.lat!.toFixed(3)}, ${best.event.lng!.toFixed(3)}`,
      lat: best.event.lat,
      lng: best.event.lng,
      source: "gps",
      confidence: best.distance <= PLACE_HIGH_MS ? "high" : "medium",
    };
  }
  if (sessionPlace) return { ...sessionPlace, confidence: sessionPlace.confidence ?? "low" };
  return undefined;
}

export function placeLabel(place?: PlaceRef): string {
  return place?.name?.trim() || "地点未知";
}
