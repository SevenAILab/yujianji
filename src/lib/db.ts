"use client";

import Dexie, { type Table } from "dexie";
import type { Item, Trip } from "./types";
import { itemSchema } from "./schema";
import type { NativeHealthSample } from "./native-bridge";

type SeedMeta = { key: string; value: boolean | string };

export type PendingEncounterRow = {
  key: "current";
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
  source: "camera" | "album" | "insta360";
};

class YujianjiDatabase extends Dexie {
  items!: Table<Item, string>;
  trips!: Table<Trip, string>;
  meta!: Table<SeedMeta, string>;
  healthSamples!: Table<NativeHealthSample & { key: string }, string>;
  pendingEncounters!: Table<PendingEncounterRow, string>;

  constructor() {
    super("yujianji");
    this.version(1).stores({ items: "id,date,country" });
    this.version(2).stores({ items: "id,date,country", meta: "key" });
    this.version(3).stores({ items: "id,date,country", meta: "key", trips: "id,status,startedAt,createdAt" });
    this.version(4).stores({ healthSamples: "key,timestamp,originId,metric" });
    this.version(5).stores({ pendingEncounters: "key" });
  }
}

export const db = new YujianjiDatabase();

const DEMO_FLAG_KEY = "demo-loaded";

async function fetchSeedItems(): Promise<Item[]> {
  const response = await fetch("/seed-data.json", { cache: "no-store" });
  if (!response.ok) throw new Error("示例内容加载失败");
  const parsed = itemSchema.array().safeParse(await response.json());
  if (!parsed.success) throw new Error("示例内容格式不正确");
  return parsed.data as Item[];
}

/**
 * 示例数据现在是「用户主动打开的展厅」，不是默认灌进个人库的东西。
 *
 * 以前 ensureSeeded() 无条件写入 25 条，新用户第一次打开看到的是别人的地图，
 * 自己的第一条记录淹没在里面。现在默认不灌，首页空状态直接引导去拍第一张。
 */
export async function hasDemoData(): Promise<boolean> {
  try {
    const flag = await db.meta.get(DEMO_FLAG_KEY);
    return flag?.value === true;
  } catch {
    return false;
  }
}

/**
 * 一次性清理：黑客松版本会无条件把 25 条示例灌进每个访客的浏览器。
 * 那些人再打开时，看到的是别人的地图，而不是自己的空白起点 ——
 * 对着公众号二维码扫进来的读者尤其糟。
 *
 * 只删 isSeed 的记录，用户自己拍的一条都不动。
 * 只在从没显式载入过示例时执行一次，之后靠 DEMO_FLAG_KEY 记账，不重复扫库。
 */
export async function clearLegacySeeds(): Promise<number> {
  try {
    const flag = await db.meta.get(DEMO_FLAG_KEY);
    // 显式载入过（true）或已经清理过（false）都不再处理。
    if (flag && (flag.value === true || flag.value === false)) return 0;

    const seeds = await db.items.filter((item) => item.isSeed).toArray();
    if (seeds.length) await db.items.bulkDelete(seeds.map((item) => item.id));
    await db.meta.put({ key: DEMO_FLAG_KEY, value: false });
    if (seeds.length) {
      console.info(JSON.stringify({ event: "legacy_seed_cleared", count: seeds.length }));
    }
    return seeds.length;
  } catch {
    return 0;
  }
}

export async function loadDemoData(): Promise<number> {
  const items = await fetchSeedItems();
  await db.items.bulkPut(items);
  await db.meta.put({ key: DEMO_FLAG_KEY, value: true });
  return items.length;
}

export async function removeDemoData(): Promise<number> {
  const seeds = await db.items.filter((item) => item.isSeed).toArray();
  await db.items.bulkDelete(seeds.map((item) => item.id));
  await db.meta.put({ key: DEMO_FLAG_KEY, value: false });
  return seeds.length;
}

/**
 * 保留这个名字是为了不动十几个调用点：现在它只负责把已加载的示例保持最新
 * （全景示例的贴图路径会变），不再凭空往用户库里灌东西。
 */
export async function ensureSeeded(): Promise<boolean> {
  if (!(await hasDemoData())) return false;
  try {
    const items = await fetchSeedItems();
    const existing = await db.items.bulkGet(items.map((item) => item.id));
    const missingOrRefreshable = items.filter(
      (item, index) => !existing[index] || item.mediaKind === "panorama",
    );
    if (missingOrRefreshable.length) await db.items.bulkPut(missingOrRefreshable);
    return missingOrRefreshable.length > 0;
  } catch {
    // 示例刷新失败不该拦住任何页面。
    return false;
  }
}
