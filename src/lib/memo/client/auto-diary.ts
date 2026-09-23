// 过零点自动补生成（工单 Gate 5.2）：网页关着的时候跑不了定时任务，数据又只在手机里，
// 所以"0 点"落地为：打开 App 时检查最近几天，今天以前还没写、或者写完之后又有新素材的日子，补写一遍。
import { db } from "../../db";
import { dayItemRange, itemDayKey } from "../day-match";
import { effectiveDecision } from "../select";
import { addMs, dayKeyIn } from "../time";
import { isFirstEncounter } from "../timeline";
import type { DiaryDay } from "../types";

export const AUTO_DIARY_LOOKBACK_DAYS = 7;

export interface DayMaterial {
  dayKey: string;
  /** 当天素材里最新的一条是什么时候进来的（片段或照片的 createdAt） */
  latestAt: string | null;
}

/** 纯函数：哪些日子要补写。今天不补（今天还没过完）；没有素材的日子不补 */
export function staleDays(input: { today: string; materials: DayMaterial[]; diaries: Map<string, Pick<DiaryDay, "generatedAt">> }): string[] {
  return input.materials
    .filter((m) => m.dayKey < input.today && m.latestAt)
    .filter((m) => {
      const diary = input.diaries.get(m.dayKey);
      return !diary || new Date(diary.generatedAt).getTime() < new Date(m.latestAt!).getTime();
    })
    .map((m) => m.dayKey)
    .sort();
}

/** 读本机数据，算出最近几天各自的素材情况 */
export async function recentMaterials(timeZone: string, now = new Date()): Promise<{ today: string; materials: DayMaterial[]; diaries: Map<string, DiaryDay> }> {
  const today = dayKeyIn(now.toISOString(), timeZone);
  const days: string[] = [];
  for (let i = 1; i <= AUTO_DIARY_LOOKBACK_DAYS; i += 1) days.push(dayKeyIn(addMs(now.toISOString(), -i * 24 * 3600_000), timeZone));
  const unique = [...new Set(days)];
  const materials: DayMaterial[] = [];
  for (const dayKey of unique) {
    const [moments, items] = await Promise.all([
      db.moments.where("dayKey").equals(dayKey).toArray(),
      db.items.where("date").between(...dayItemRange(dayKey), true, true).toArray(),
    ]);
    const times = [
      ...moments.filter((m) => effectiveDecision(m) === "keep").map((m) => m.createdAt),
      ...items.filter((item) => isFirstEncounter(item) && itemDayKey(item, timeZone) === dayKey).map((item) => item.createdAt),
    ].filter((t) => Number.isFinite(new Date(t).getTime()));
    materials.push({ dayKey, latestAt: times.length ? times.sort().at(-1)! : null });
  }
  const diaries = new Map((await db.diaryDays.bulkGet(unique)).filter((d): d is DiaryDay => Boolean(d)).map((d) => [d.dayKey, d]));
  return { today, materials, diaries };
}
