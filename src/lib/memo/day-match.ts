// 日终补配图（纯函数，客户端、服务端、测试共用）。
//
// judge 阶段只能配"录音时已经存在"的照片（±90 分钟 + 2km），录完才拍的永远配不上。
// 一天结束写手帐前，再给还空着的片段补一次：候选是当天所有还没被占用的照片。
//
// 这是基于识别结果的语义匹配：模型拿到的是照片的识别名称、类别、地点、时间，不是图片本身。
//
// 契约（工单 Gate 1.2）：
// - 只补 effectiveDecision = keep、category 属于 PHOTO_CATEGORIES、还没有 photoId 的片段；judge 配的一律不覆盖
// - 候选外、待补列表外的 id 丢弃；一段一张、一张一段；冲突按 salience 降序 → 时间升序 → id 升序
// - 签名取"补完之后剩下的集合"：没变就说明模型看过、对不上，不再花钱重问
import { PHOTO_CATEGORIES } from "./guards";
import { placeLabel } from "./place";
import { DAY_MATCH_MAX_MOMENTS, DAY_MATCH_MAX_PHOTOS, type MatchOutput } from "./schema";
import { compareForPhoto, dedupePhotos, effectiveDecision, quotesForWriting } from "./select";
import { clockIn, dayKeyIn } from "./time";
import type { Item } from "../types";
import type { Moment } from "./types";

export interface DayMatchMoment {
  id: string;
  at: string;
  salience: number;
  time: string;
  place: string;
  category: Moment["category"];
  trigger: string;
  quote: string;
}

export interface DayMatchPhoto {
  id: string;
  name: string;
  category: string;
  place: string;
  time: string;
}

export interface DayMatchInput {
  moments: DayMatchMoment[];
  photos: DayMatchPhoto[];
}

type MatchableItem = Pick<Item, "id" | "name" | "category" | "place" | "date" | "isSeed">;

function validIso(iso: string): boolean {
  return Number.isFinite(new Date(iso).getTime());
}

/**
 * 查某一天照片用的 UTC 时间范围：前后各放宽 15 小时，覆盖 -12 到 +14 的所有时区，
 * 再用 itemDayKey 精确过滤。照片存的是 base64 大字段，不能整表读进内存。
 */
export function dayItemRange(dayKey: string): [string, string] {
  const start = new Date(`${dayKey}T00:00:00.000Z`).getTime();
  const pad = 15 * 3600_000;
  return [new Date(start - pad).toISOString(), new Date(start + 24 * 3600_000 + pad).toISOString()];
}

/** 这张照片属于哪一天（设备时区）。日期读不出来就不归任何一天。 */
export function itemDayKey(item: Pick<Item, "date">, timeZone: string): string | null {
  return validIso(item.date) ? dayKeyIn(item.date, timeZone) : null;
}

/** 选出这一天要补配的片段和候选照片 */
export function selectDayMatchInput(input: {
  dayKey: string;
  moments: Moment[];
  items: MatchableItem[];
  timeZone: string;
  /** 片段时间按会话时区显示；取不到就用设备时区 */
  momentTimeZone?: (m: Moment) => string;
}): DayMatchInput {
  const { dayKey, moments, items, timeZone } = input;
  const taken = new Set(dedupePhotos(moments).values());
  const pending = moments
    .filter((m) => m.dayKey === dayKey && !m.photoId && effectiveDecision(m) === "keep" && PHOTO_CATEGORIES.has(m.category))
    .filter((m) => quotesForWriting(m).length > 0)
    .sort(compareForPhoto)
    .slice(0, DAY_MATCH_MAX_MOMENTS)
    .map((m) => ({
      id: m.id,
      at: m.at,
      salience: m.salience,
      time: clockIn(m.at, input.momentTimeZone?.(m) ?? timeZone),
      place: placeLabel(m.place).slice(0, 120),
      category: m.category,
      trigger: m.trigger.slice(0, 80),
      quote: quotesForWriting(m).join(" ").slice(0, 400),
    }));
  const photos = items
    .filter((item) => !item.isSeed && !taken.has(item.id) && itemDayKey(item, timeZone) === dayKey)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, DAY_MATCH_MAX_PHOTOS)
    .map((item) => ({
      id: item.id,
      name: item.name.slice(0, 80),
      category: String(item.category ?? "").slice(0, 40),
      place: (item.place || "地点未知").slice(0, 120),
      time: clockIn(item.date, timeZone),
    }));
  return { moments: pending, photos };
}

/** FNV-1a 32 位：只用来判断"这批输入是否和上次一样"，不做安全用途 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function dayMatchSignature(input: Pick<DayMatchInput, "moments" | "photos">): string {
  const moments = input.moments.map((m) => m.id).sort().join(",");
  const photos = input.photos.map((p) => p.id).sort().join(",");
  return fnv1a(`m:${moments}|p:${photos}`);
}

export interface DayMatchApplied {
  accepted: { momentId: string; photoId: string; reason: string }[];
  /** 被守卫丢掉的，写进 trace（G10） */
  rejected: string[];
}

/** 代码守卫：模型说了不算 */
export function applyDayMatches(input: DayMatchInput, output: MatchOutput): DayMatchApplied {
  const momentById = new Map(input.moments.map((m) => [m.id, m]));
  const photoIds = new Set(input.photos.map((p) => p.id));
  const rejected: string[] = [];
  const valid = output.matches.filter((match) => {
    if (!momentById.has(match.momentId)) {
      rejected.push(`${match.momentId} 不在待补列表里 → 丢掉`);
      return false;
    }
    if (!photoIds.has(match.photoId)) {
      rejected.push(`${match.photoId} 不在当天候选里 → 丢掉`);
      return false;
    }
    return true;
  });
  valid.sort((a, b) => compareForPhoto(momentById.get(a.momentId)!, momentById.get(b.momentId)!));
  const usedMoments = new Set<string>();
  const usedPhotos = new Set<string>();
  const accepted: DayMatchApplied["accepted"] = [];
  for (const match of valid) {
    if (usedMoments.has(match.momentId)) {
      rejected.push(`${match.momentId} 已经配了一张 → 多出来的丢掉`);
      continue;
    }
    if (usedPhotos.has(match.photoId)) {
      rejected.push(`${match.photoId} 已经给了更重要的片段 → 这段留白`);
      continue;
    }
    usedMoments.add(match.momentId);
    usedPhotos.add(match.photoId);
    accepted.push({ momentId: match.momentId, photoId: match.photoId, reason: match.reason });
  }
  return { accepted, rejected };
}

/** 补完之后还剩下的集合（用来算下次的签名） */
export function remainingAfter(input: DayMatchInput, accepted: DayMatchApplied["accepted"]): DayMatchInput {
  const doneMoments = new Set(accepted.map((a) => a.momentId));
  const donePhotos = new Set(accepted.map((a) => a.photoId));
  return {
    moments: input.moments.filter((m) => !doneMoments.has(m.id)),
    photos: input.photos.filter((p) => !donePhotos.has(p.id)),
  };
}
