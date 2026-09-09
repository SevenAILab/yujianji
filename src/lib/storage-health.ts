"use client";

import { db } from "./db";

export type PersistState = "persisted" | "not-persisted" | "unsupported";

export interface StorageHealth {
  persist: PersistState;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** 0–1；拿不到配额时为 null，不猜。 */
  ratio: number | null;
}

const LAST_EXPORT_KEY = "last-export-at";

/**
 * 请求持久化存储。这是 iOS Safari「7 天未访问清空脚本可写存储」的主要缓解手段：
 * 站点被加到主屏幕后通常会被授予；Chrome 依据用户参与度决定。
 *
 * 两个 API 在隐私模式、旧内核、WebView 里都可能缺失或直接抛错，
 * 所以全程 try/catch —— 存储状态读不出来绝不能让页面白掉。
 */
export async function requestPersistence(): Promise<PersistState> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) {
      return "unsupported";
    }
    if (await navigator.storage.persisted?.()) return "persisted";
    return (await navigator.storage.persist()) ? "persisted" : "not-persisted";
  } catch {
    return "unsupported";
  }
}

export async function readStorageHealth(): Promise<StorageHealth> {
  let persist: PersistState = "unsupported";
  try {
    if (navigator.storage?.persisted) {
      persist = (await navigator.storage.persisted()) ? "persisted" : "not-persisted";
    }
  } catch {
    persist = "unsupported";
  }

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      usageBytes = typeof estimate.usage === "number" ? estimate.usage : null;
      quotaBytes = typeof estimate.quota === "number" ? estimate.quota : null;
    }
  } catch {
    // 保持 null。宁可不显示，也不显示一个编出来的数字。
  }

  const ratio =
    usageBytes !== null && quotaBytes !== null && quotaBytes > 0
      ? usageBytes / quotaBytes
      : null;

  return { persist, usageBytes, quotaBytes, ratio };
}

export async function readLastExportAt(): Promise<string | null> {
  try {
    const row = await db.meta.get(LAST_EXPORT_KEY);
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

export async function markExported(): Promise<void> {
  try {
    await db.meta.put({ key: LAST_EXPORT_KEY, value: new Date().toISOString() });
  } catch {
    // 记不上不影响导出本身。
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** 攒了足够多记录、又超过 30 天没导出过 → 该提醒一次备份了。 */
export function shouldSuggestBackup(itemCount: number, lastExportAt: string | null): boolean {
  if (itemCount < 10) return false;
  if (!lastExportAt) return true;
  const parsed = Date.parse(lastExportAt);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed > THIRTY_DAYS_MS;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
