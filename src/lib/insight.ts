import { CATEGORY_LABELS, type Category, type Item } from "./types";

export type InsightKind =
  | "anniversary"
  | "memory"
  | "place"
  | "milestone"
  | "span"
  | "category";

export interface InsightFact {
  kind: InsightKind;
  /** 由代码算出的客观事实。模型只负责把它说成人话，不负责产生它。 */
  fact: string;
  /** 去重用：最近几天说过的 key 不再说第二次。 */
  key: string;
}

/** 藏品少于这个数就不说话——宁可整行不渲染，也不说凑数的话。 */
export const INSIGHT_MIN_ITEMS = 3;

/**
 * date 形如 2025-10-12T16:32:00+08:00。
 * 直接截字符串取当地日历日，不走 Date 解析，避免时区把 10-12 读成 10-11。
 */
function localDate(
  date: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** place 形如「浙江 · 莫干山」，取分隔符前的省/国当作地区。 */
function regionOf(place: string): string {
  const text = (place ?? "").trim();
  if (!text) return "";
  return (text.split(/\s*·\s*/)[0] ?? "").trim();
}

/**
 * 按 code point 排序，不用 localeCompare。
 * localeCompare 对中文的顺序依赖运行环境的 ICU 数据，不同浏览器可能不一致，
 * 会让同一份数据在评委的手机上选出和我们不一样的地区。
 */
function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 稳定哈希：同一天 + 同样的藏品数，必须得到同一句话。 */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

type UsableItem = Item & {
  parsed: { year: number; month: number; day: number };
};

function toUsable(items: Item[]): UsableItem[] {
  const usable: UsableItem[] = [];
  for (const item of items) {
    const parsed = localDate(item.date);
    if (!parsed) continue;
    if (!item.name?.trim()) continue;
    usable.push({ ...item, parsed });
  }
  return usable;
}

function memoryFact(item: UsableItem): InsightFact {
  return {
    kind: "memory",
    fact: `${item.parsed.year}年${item.parsed.month}月，你在「${item.place}」遇见了「${item.name}」`,
    key: `memory:${item.id}`,
  };
}

/**
 * 构建全部候选事实。
 *
 * 硬约束：池子里每一条都是「有」——描述已经发生、已经拥有的事。
 * 任何「还没 / 尚未 / 已经 N 天没」的缺席型表达都不允许进入这里。
 */
export function buildInsightPool(items: Item[], today: Date): InsightFact[] {
  const usable = toUsable(items);
  if (usable.length < INSIGHT_MIN_ITEMS) return [];

  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();
  const todayYear = today.getFullYear();
  const seed = hashString(
    `${todayYear}-${todayMonth}-${todayDay}:${usable.length}`,
  );

  const pool: InsightFact[] = [];

  // ── anniversary：同月同日的往年记录，多条取最早那条 ────────────────
  const anniversaries = usable
    .filter(
      (item) =>
        item.parsed.month === todayMonth &&
        item.parsed.day === todayDay &&
        item.parsed.year < todayYear,
    )
    .sort((a, b) => a.parsed.year - b.parsed.year);
  const anniversary = anniversaries[0];
  if (anniversary) {
    pool.push({
      kind: "anniversary",
      fact: `${anniversary.parsed.year}年的今天，你在「${anniversary.place}」遇见了「${anniversary.name}」`,
      key: `anniversary:${anniversary.id}`,
    });
  }

  // ── memory：翻 3 条不同的旧记录，让它占到池子的一半左右 ────────────
  const byDate = [...usable].sort((a, b) => a.date.localeCompare(b.date));
  const takenIndexes = new Set<number>();
  for (let step = 0; step < 3 && takenIndexes.size < byDate.length; step += 1) {
    // 质数步长，避免每次都取到相邻的几条
    let index = (seed + step * 7919) % byDate.length;
    let guard = 0;
    while (takenIndexes.has(index) && guard < byDate.length) {
      index = (index + 1) % byDate.length;
      guard += 1;
    }
    if (takenIndexes.has(index)) break;
    takenIndexes.add(index);
    pool.push(memoryFact(byDate[index]));
  }

  // ── place：某个地区收了 ≥2 件 ────────────────────────────────────
  const byRegion = new Map<string, UsableItem[]>();
  for (const item of usable) {
    const region = regionOf(item.place);
    if (!region) continue;
    const bucket = byRegion.get(region);
    if (bucket) bucket.push(item);
    else byRegion.set(region, [item]);
  }
  const regionCandidates = [...byRegion.entries()]
    .filter(([, bucket]) => bucket.length >= 2)
    .sort((a, b) => compareCodePoint(a[0], b[0]));
  if (regionCandidates.length) {
    const [region, bucket] = regionCandidates[seed % regionCandidates.length];
    const earliest = [...bucket].sort((a, b) => a.date.localeCompare(b.date))[0];
    pool.push({
      kind: "place",
      fact: `你在「${region}」一共收藏了 ${bucket.length} 件，最早的一件是 ${earliest.parsed.year} 年的「${earliest.name}」`,
      key: `place:${region}`,
    });
  }

  // ── milestone：总量 + 国家数 ─────────────────────────────────────
  const countries = new Set(
    usable.map((item) => item.country).filter((code) => code && code !== "UNK"),
  );
  if (countries.size >= 1) {
    pool.push({
      kind: "milestone",
      fact: `你已经收藏了 ${usable.length} 件，来自 ${countries.size} 个国家或地区`,
      key: `milestone:${usable.length}-${countries.size}`,
    });
  }

  // ── span：收藏的年份跨度 ─────────────────────────────────────────
  const years = usable.map((item) => item.parsed.year);
  const earliestYear = Math.min(...years);
  const spanYears = Math.max(...years) - earliestYear + 1;
  if (spanYears >= 2) {
    const earliestItem = [...usable].sort((a, b) =>
      a.date.localeCompare(b.date),
    )[0];
    pool.push({
      kind: "span",
      fact: `你的收藏横跨 ${spanYears} 年，最早的一件是 ${earliestItem.parsed.year} 年在「${earliestItem.place}」的「${earliestItem.name}」`,
      key: `span:${spanYears}`,
    });
  }

  // ── category：收得最多的那一类 ───────────────────────────────────
  const byCategory = new Map<Category, number>();
  for (const item of usable) {
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  }
  const topCategory = [...byCategory.entries()].sort(
    (a, b) => b[1] - a[1] || compareCodePoint(a[0], b[0]),
  )[0];
  if (topCategory && topCategory[1] >= 2) {
    pool.push({
      kind: "category",
      fact: `你收藏最多的是${CATEGORY_LABELS[topCategory[0]]}，一共 ${topCategory[1]} 件`,
      key: `category:${topCategory[0]}-${topCategory[1]}`,
    });
  }

  return pool;
}

/**
 * 选出今天要说的那一条事实。纯函数，不调模型。
 *
 * - 藏品 < 3 件 → null（首页整行不渲染）
 * - 命中周年 → 直接用，优先级最高
 * - 否则按 seed 从池子里取，撞上最近说过的 key 就顺延
 */
export function pickInsightFact(
  items: Item[],
  today: Date,
  recentKeys: string[] = [],
): InsightFact | null {
  const pool = buildInsightPool(items, today);
  if (!pool.length) return null;

  const anniversary = pool.find((fact) => fact.kind === "anniversary");
  if (anniversary) return anniversary;

  const usableCount = toUsable(items).length;
  const seed = hashString(
    `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}:${usableCount}`,
  );
  const recent = new Set(recentKeys);

  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(seed + offset) % pool.length];
    if (!recent.has(candidate.key)) return candidate;
  }

  // 池子里每一条最近都说过：宁可重复，也好过首页突然没话说
  return pool[seed % pool.length];
}
