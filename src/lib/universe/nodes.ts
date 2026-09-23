// 记忆宇宙的数据层（工单 Gate 4.1）：纯函数，不依赖 three，页面和测试共用。
//
// 一个节点 = 一个"初见"物件（计划 §6-1 默认）。按拍摄时间从里往外填圈：
// 第 1 圈 5 个，之后每圈多 3 个——最早的第一次在最里面，自带时间线。
//
// 模型来自吉米产出的 public/assets/models/manifest.json（按 itemId 对上）。
// 清单缺失、损坏、字段不合法、URL 不是站内路径、藏品已删除，一律当作"还没成形"，不报错。
import { dedupePhotos } from "../memo/select";
import { itemDayKey } from "../memo/day-match";
import { isFirstEncounter, momentAnchor, photoAnchor } from "../memo/timeline";
import type { Item } from "../types";
import type { Moment } from "../memo/types";

export const FIRST_RING = 5;
export const RING_STEP = 3;

export interface ModelEntry {
  glbUrl: string;
  bbox?: [number, number, number];
  color?: string;
}

export interface UniverseNode {
  id: string;
  name: string;
  at: string;
  /** 设备时区里属于哪一天；示例节点没有 */
  dayKey?: string;
  /** 点了跳到哪：那天手帐里配到这张图的段落，否则是它的照片条目。示例节点为空，不可点 */
  href?: string;
  model?: ModelEntry;
  color?: string;
  sample: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** 只接受站内相对路径：以 / 开头、不以 // 开头、不带协议 */
export function isSameOriginPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !/^\/[^/]*:/.test(url) && url.length < 300;
}

export function parseManifest(raw: unknown): Map<string, ModelEntry> {
  const out = new Map<string, ModelEntry>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [itemId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (!isSameOriginPath(entry.glbUrl)) continue;
    const bbox = Array.isArray(entry.bbox) && entry.bbox.length === 3 && entry.bbox.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) ? (entry.bbox as [number, number, number]) : undefined;
    const color = typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : undefined;
    out.set(itemId, { glbUrl: entry.glbUrl, ...(bbox ? { bbox } : {}), ...(color ? { color } : {}) });
  }
  return out;
}

type NodeItem = Pick<Item, "id" | "name" | "date" | "isSeed" | "ai">;

export function buildUniverseNodes(input: {
  items: NodeItem[];
  moments: Moment[];
  manifest: Map<string, ModelEntry>;
  timeZone: string;
}): UniverseNode[] {
  const photoToMoment = new Map<string, string>();
  for (const [momentId, photoId] of dedupePhotos(input.moments)) photoToMoment.set(photoId, momentId);
  return input.items
    .filter((item) => isFirstEncounter(item) && Number.isFinite(new Date(item.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || (a.id < b.id ? -1 : 1))
    .map((item) => {
      const dayKey = itemDayKey(item, input.timeZone) ?? undefined;
      const momentId = photoToMoment.get(item.id);
      const model = input.manifest.get(item.id);
      return {
        id: item.id,
        name: item.name,
        at: item.date,
        dayKey,
        href: dayKey ? `/memo/day/${dayKey}#${momentId ? momentAnchor(momentId) : photoAnchor(item.id)}` : undefined,
        ...(model ? { model, color: model.color } : {}),
        sample: false,
      };
    });
}

/** 9/22 的示例 encounters.json：本地一个初见都没有时才用，节点不可点 */
export function sampleNodes(raw: unknown): UniverseNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .filter((e) => typeof e.id === "string" && typeof e.label === "string")
    .map((e) => ({
      id: `sample:${e.id as string}`,
      name: e.label as string,
      at: typeof e.capturedAt === "string" ? e.capturedAt : "",
      color: typeof e.color === "string" && HEX.test(e.color) ? e.color : undefined,
      sample: true,
    }))
    .sort((a, b) => (new Date(a.at).getTime() || 0) - (new Date(b.at).getTime() || 0));
}

export interface RingSlot {
  ring: number;
  index: number;
  size: number;
}

/** 第几个节点落在第几圈的第几个位置：第 1 圈 5 个，之后每圈多 3 个 */
export function ringSlots(count: number, first = FIRST_RING, step = RING_STEP): RingSlot[] {
  const slots: RingSlot[] = [];
  let ring = 0;
  let capacity = first;
  let index = 0;
  for (let i = 0; i < count; i += 1) {
    if (index >= capacity) {
      ring += 1;
      capacity += step;
      index = 0;
    }
    slots.push({ ring, index, size: capacity });
    index += 1;
  }
  // 最外圈没填满时，按实际个数均分，别挤在半边
  const last = slots.at(-1)?.ring;
  const lastCount = slots.filter((s) => s.ring === last).length;
  return slots.map((s) => (s.ring === last ? { ...s, size: lastCount } : s));
}
