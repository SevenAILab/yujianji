"use client";

import { z } from "zod";
import { db } from "./db";
import { itemSchema, tripSchema } from "./schema";
import type { Item, Trip } from "./types";
import { markExported } from "./storage-health";

export const BACKUP_VERSION = 2;

/**
 * v2 起备份包含遇见手记。
 *
 * 之前只备份照片，但隐私页明确告诉用户「定期导出备份」——用户照做、换了设备，
 * 手记、片段、画像会全部丢失。手记数据只存在这台手机上，备份是唯一的出路。
 *
 * **逐字稿（utterances）故意不备份**：它有 7 天 TTL，含同伴的原话，
 * 产品承诺到期清理。备份里带上它等于绕过这个承诺。
 * 手记里"我"的原话存在 moment.myQuotes 上，随片段一起备份，不受影响。
 */
const backupSchema = z.object({
  format: z.literal("yujianji-backup"),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  items: itemSchema.array(),
  trips: tripSchema.array().optional(),
  memo: z
    .object({
      sessions: z.array(z.unknown()),
      moments: z.array(z.unknown()),
      diaryDays: z.array(z.unknown()),
      profiles: z.array(z.unknown()),
      feedbackEvents: z.array(z.unknown()),
      timeline: z.array(z.unknown()),
      traces: z.array(z.unknown()),
    })
    .optional(),
});

export type BackupFile = z.infer<typeof backupSchema>;

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
  trips: number;
  /** v2：恢复的手记相关记录条数（会话 + 片段 + 手记 + 画像 + 反馈 + 时间轴 + 过程） */
  memo: number;
}

/**
 * 导出全部数据，**包含原图 base64**。
 *
 * 服务端不存任何照片，所以这个文件是用户唯一能把照片带到另一台设备的通道。
 * 它不是合规摆设，是核心功能 —— 别为了文件小把 photo 删掉。
 */
export async function buildBackup(): Promise<BackupFile> {
  const empty = <T>() => [] as T[];
  const [items, trips, sessions, moments, diaryDays, profiles, feedbackEvents, timeline, traces] = await Promise.all([
    db.items.toArray(),
    db.trips.toArray().catch(() => empty<Trip>()),
    db.memoSessions.toArray().catch(empty),
    db.moments.toArray().catch(empty),
    db.diaryDays.toArray().catch(empty),
    db.profiles.toArray().catch(empty),
    db.feedbackEvents.toArray().catch(empty),
    db.timeline.toArray().catch(empty),
    db.agentTraces.toArray().catch(empty),
  ]);
  return {
    format: "yujianji-backup",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    // 示例数据不属于用户，不进备份，免得导入后越滚越多。
    items: items.filter((item) => !item.isSeed),
    trips,
    // 逐字稿不在这里：7 天 TTL 是对同伴原话的承诺，备份不能绕过它
    memo: { sessions, moments, diaryDays, profiles, feedbackEvents, timeline, traces },
  };
}

export async function downloadBackup(): Promise<number> {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `遇见集备份-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari 需要给点时间把 blob 交给下载器再撤销。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await markExported();
  return backup.items.length;
}

export interface MergeResult {
  toWrite: Item[];
  added: number;
  updated: number;
  skipped: number;
}

/**
 * 合并策略：按 id 对齐，以 createdAt 更晚的一方为准。
 *
 * 纯函数，方便单测。`existing[i]` 对应 `incoming[i]`（Dexie bulkGet 的返回约定），
 * 没有对应记录时是 undefined。
 */
export function mergeBackupItems(
  incoming: Item[],
  existing: Array<Item | undefined>,
): MergeResult {
  const toWrite: Item[] = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  incoming.forEach((item, index) => {
    const current = existing[index];
    if (!current) {
      toWrite.push(item);
      added += 1;
      return;
    }
    if (Date.parse(item.createdAt) > Date.parse(current.createdAt)) {
      toWrite.push(item);
      updated += 1;
    } else {
      skipped += 1;
    }
  });

  return { toWrite, added, updated, skipped };
}

/**
 * 按 id 合并，不是覆盖整库。
 * 同一份文件导入两次不会产生重复记录，也不会把用户在新设备上新建的记录冲掉。
 */
export async function importBackup(file: File): Promise<ImportSummary> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error("这个文件不是有效的 JSON，请确认选对了备份文件。");
  }

  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("这个文件不是遇见集的备份，或者版本对不上。");
  }
  if (parsed.data.version > BACKUP_VERSION) {
    throw new Error("这份备份来自更新版本的遇见集，请先升级再导入。");
  }

  const incoming = parsed.data.items as Item[];
  const existing = await db.items.bulkGet(incoming.map((item) => item.id));
  const { toWrite, added, updated, skipped } = mergeBackupItems(incoming, existing);

  if (toWrite.length) await db.items.bulkPut(toWrite);

  let trips = 0;
  if (parsed.data.trips?.length) {
    await db.trips.bulkPut(parsed.data.trips as Trip[]);
    trips = parsed.data.trips.length;
  }

  // v2：手记。整表覆盖式写入，同 id 以备份为准；逐字稿不在备份里，恢复后过程页看不到原句，这是有意的。
  let memo = 0;
  const m = parsed.data.memo;
  if (m) {
    const put = async (table: { bulkPut: (rows: never[]) => Promise<unknown> }, rows: unknown[]) => {
      if (!rows.length) return;
      await table.bulkPut(rows as never[]);
      memo += rows.length;
    };
    await put(db.memoSessions, m.sessions);
    await put(db.moments, m.moments);
    await put(db.diaryDays, m.diaryDays);
    await put(db.profiles, m.profiles);
    await put(db.feedbackEvents, m.feedbackEvents);
    await put(db.timeline, m.timeline);
    await put(db.agentTraces, m.traces);
  }

  return { added, updated, skipped, trips, memo };
}

/** 删除本机全部用户数据。示例数据一并清掉，回到全新状态。 */
export async function wipeLocalData(): Promise<void> {
  await db.transaction("rw", db.items, db.trips, db.meta, db.healthSamples, db.pendingEncounters, async () => {
    await db.items.clear();
    await db.trips.clear();
    await db.healthSamples.clear();
    await db.pendingEncounters.clear();
    // meta 里除了设备标识都清掉：设备标识留着，否则配额会被绕过。
    const rows = await db.meta.toArray();
    await Promise.all(
      rows.filter((row) => row.key !== "device-id").map((row) => db.meta.delete(row.key)),
    );
  });
}
