"use client";

import { nanoid } from "nanoid";
import { db } from "./db";

const STORAGE_KEY = "yujianji-device-id";
const META_KEY = "device-id";

let cached: string | null = null;
let pending: Promise<string> | null = null;

function readLocalStorage(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length >= 8 ? value : null;
  } catch {
    // Safari 隐私模式 / 站点数据被禁用时 localStorage 直接抛错。
    return null;
  }
}

function writeLocalStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 写不进去不影响使用：IndexedDB 那一份还在。
  }
}

async function readIndexedDb(): Promise<string | null> {
  try {
    const row = await db.meta.get(META_KEY);
    return typeof row?.value === "string" && row.value.length >= 8 ? row.value : null;
  } catch {
    return null;
  }
}

async function writeIndexedDb(value: string): Promise<void> {
  try {
    await db.meta.put({ key: META_KEY, value });
  } catch {
    // 同上，两处存一处能活就行。
  }
}

/**
 * 设备标识。双写 localStorage 和 IndexedDB：两者都会被清，但很少同时被清，
 * 双写能明显提高「用户回来时还是同一个设备」的概率。
 * 它只用于配额和滥用防护，不是账号，不含任何个人信息。
 */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const fromLocal = readLocalStorage();
    const fromDb = await readIndexedDb();
    const existing = fromLocal ?? fromDb;
    const id = existing ?? `dev_${nanoid(20)}`;

    // 任何一边缺了就补上，让两份保持同步。
    if (fromLocal !== id) writeLocalStorage(id);
    if (fromDb !== id) await writeIndexedDb(id);

    cached = id;
    return id;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** 同步读取，只在已经初始化过之后可用；拿不到返回 null，调用方需容忍。 */
export function peekDeviceId(): string | null {
  return cached ?? readLocalStorage();
}
