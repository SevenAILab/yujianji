"use client";

import Dexie, { type Table } from "dexie";
import type { Item } from "./types";
import { itemSchema } from "./schema";

class YujianjiDatabase extends Dexie {
  items!: Table<Item, string>;

  constructor() {
    super("yujianji");
    this.version(1).stores({
      items: "id,date,country",
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
      const existing = await db.items.bulkGet(items.map((item) => item.id));
      const writes = items.map((item, index) => {
        const current = existing[index];
        return current?.answer ? { ...item, answer: current.answer } : item;
      });
      await db.items.bulkPut(writes);
      return items.some((item, index) => !existing[index]);
    })();
    seedPromise = pending.catch((error) => {
      seedPromise = null;
      throw error;
    });
  }

  return seedPromise;
}
