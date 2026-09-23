// 手帐时间线（工单 Gate 1.3）：正文段落 + "只拍没说"的初见照片，按时间合并成一条线。
// 纯函数、不落库、不调模型——手帐页、旅途页封面、宇宙跳转都用这一份，别各算各的。
import { itemDayKey } from "./day-match";
import { dedupePhotos } from "./select";
import type { Item } from "../types";
import type { DiaryParagraph, Moment } from "./types";

export type DiaryTimelineItem =
  | { kind: "moment"; momentId: string; at: string; paragraph: DiaryParagraph; photoId?: string }
  | { kind: "photo"; itemId: string; at: string; name: string; place: string };

type TimelineItemSource = Pick<Item, "id" | "name" | "place" | "date" | "isSeed" | "ai">;

/** 只有识别完成、判为"初见"的照片才算——识别还没回来（ai 为空）的不当初见 */
export function isFirstEncounter(item: Pick<Item, "isSeed" | "ai">): boolean {
  return !item.isSeed && item.ai?.verdict === "first";
}

/** 当天被正文段落用掉的照片：momentId → photoId */
export function photosByMoment(moments: Moment[]): Map<string, string> {
  return dedupePhotos(moments);
}

export function buildDiaryTimeline(input: {
  dayKey: string;
  paragraphs: DiaryParagraph[];
  moments: Moment[];
  items: TimelineItemSource[];
  timeZone: string;
}): DiaryTimelineItem[] {
  const byId = new Map(input.moments.map((m) => [m.id, m]));
  const photoByMoment = photosByMoment(input.moments);
  const used = new Set(photoByMoment.values());

  const entries: DiaryTimelineItem[] = [];
  for (const paragraph of input.paragraphs) {
    const moment = byId.get(paragraph.momentId);
    entries.push({
      kind: "moment",
      momentId: paragraph.momentId,
      at: moment?.at ?? "",
      paragraph,
      ...(photoByMoment.get(paragraph.momentId) ? { photoId: photoByMoment.get(paragraph.momentId) } : {}),
    });
  }
  for (const item of input.items) {
    if (!isFirstEncounter(item) || used.has(item.id)) continue;
    if (itemDayKey(item, input.timeZone) !== input.dayKey) continue;
    entries.push({ kind: "photo", itemId: item.id, at: item.date, name: item.name, place: item.place });
  }

  const time = (e: DiaryTimelineItem) => {
    const t = new Date(e.at).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  // 按时间升序；同一时刻段落在前；再按 id 保证稳定
  return entries.sort((a, b) => {
    const diff = time(a) - time(b);
    if (diff) return diff;
    if (a.kind !== b.kind) return a.kind === "moment" ? -1 : 1;
    const ida = a.kind === "moment" ? a.momentId : a.itemId;
    const idb = b.kind === "moment" ? b.momentId : b.itemId;
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
}

/** 手帐封面：第一张配图 → 第一张照片条目 → 没有 */
export function diaryCoverItemId(timeline: DiaryTimelineItem[]): string | undefined {
  const withPhoto = timeline.find((e) => e.kind === "moment" && e.photoId);
  if (withPhoto?.kind === "moment") return withPhoto.photoId;
  const photo = timeline.find((e) => e.kind === "photo");
  return photo?.kind === "photo" ? photo.itemId : undefined;
}

/** 手帐页锚点（宇宙跳转用） */
export const momentAnchor = (momentId: string) => `m-${momentId}`;
export const photoAnchor = (itemId: string) => `p-${itemId}`;
