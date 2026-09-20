import { tool } from "ai";
import { z } from "zod";

export interface NearbyItem {
  id: string;
  name: string;
  place: string;
  time: string;
}

export function findPhotosInWindow(items: NearbyItem[], aroundIso: string, windowMin = 90): NearbyItem[] {
  const around = new Date(aroundIso).getTime();
  if (!Number.isFinite(around)) return [];
  return items
    .map((item) => ({ item, distance: Math.abs(new Date(item.time).getTime() - around) }))
    .filter((x) => Number.isFinite(x.distance) && x.distance <= windowMin * 60_000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10)
    .map((x) => x.item);
}

/** P1：在请求带来的 nearbyItems（遇见集藏品，±90 分钟）里找同时段照片 */
export function findPhotosTool(items: NearbyItem[]) {
  return tool({
    description: "找用户在某个时间前后拍的照片（遇见集里的藏品），返回 id、名称、地点、时间。感想指向一个看到的东西，或导入的录音需要推断地点时用。",
    inputSchema: z.object({
      aroundIso: z.string().max(40).describe("ISO 时间"),
      windowMin: z.number().int().min(5).max(180).optional().describe("前后多少分钟，默认 90"),
    }),
    execute: async ({ aroundIso, windowMin }) => {
      const photos = findPhotosInWindow(items, aroundIso, windowMin ?? 90);
      return photos.length ? { photos } : { error: "NO_MATCH", hint: "这个时间附近没有照片" };
    },
  });
}
