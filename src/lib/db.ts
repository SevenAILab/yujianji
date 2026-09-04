"use client";

import Dexie, { type Table } from "dexie";
import type { Item } from "./types";
import { itemSchema } from "./schema";

type SeedMeta = {
  key: string;
  value: boolean | string;
};

class YujianjiDatabase extends Dexie {
  items!: Table<Item, string>;
  meta!: Table<SeedMeta, string>;

  constructor() {
    super("yujianji");
    this.version(1).stores({
      items: "id,date,country",
    });
    this.version(2).stores({
      items: "id,date,country",
      meta: "key",
    });
  }
}

export const db = new YujianjiDatabase();

let seedPromise: Promise<boolean> | null = null;

export function ensureSeeded(): Promise<boolean> {
  if (!seedPromise) {
    const pending = (async () => {
      const response = await fetch("/seed-data.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("示例历史加载失败");
      }

      const parsed = itemSchema.array().safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("示例历史格式不正确");
      }

      const items = parsed.data as Item[];
      const seedIds = items.map((item) => item.id);
      const storedIds = await db.meta.get("seeded-ids");
      const legacyMarker = await db.meta.get("seeded");
      const seededIds = new Set<string>(
        typeof storedIds?.value === "string"
          ? (JSON.parse(storedIds.value) as string[])
          : legacyMarker?.value === true
            ? seedIds
            : [],
      );
      const existing = await db.items.bulkGet(items.map((item) => item.id));
      const missing = items.filter(
        (item, index) => !existing[index] && !seededIds.has(item.id),
      );
      if (missing.length) await db.items.bulkPut(missing);
      await db.meta.put({
        key: "seeded-ids",
        value: JSON.stringify([...new Set([...seededIds, ...seedIds])]),
      });
      return missing.length > 0;
    })();
    seedPromise = pending.catch((error) => {
      seedPromise = null;
      throw error;
    });
  }

  return seedPromise;
}
