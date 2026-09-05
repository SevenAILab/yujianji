"use client";

import { useEffect, useState } from "react";
import { db } from "@/lib/db";
import { INSIGHT_MIN_ITEMS, pickInsightFact } from "@/lib/insight";
import type { Item } from "@/lib/types";

const TODAY_META_KEY = "insight-today";
const RECENT_META_KEY = "insight-recent-keys";
/** 最近几天说过的话不再重复说。 */
const RECENT_DAYS = 3;

type TodayCache = {
  date: string;
  itemCount: number;
  line: string;
  key: string;
};

type RecentEntry = { date: string; key: string };

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseMeta<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * 首页那一句话。
 *
 * 事实由 pickInsightFact 用代码算出，模型只负责把它说成人话；
 * 模型失败时直接显示事实原文——所以这一行永远真实，也永远说得出话。
 */
export function InsightLine({ items }: { items: Item[] }) {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    if (items.length < INSIGHT_MIN_ITEMS) {
      setLine(null);
      return;
    }

    let active = true;

    (async () => {
      const today = new Date();
      const todayKey = localDayKey(today);

      // 同一天、藏品数没变 → 直接用缓存，不再打接口
      const cachedRow = await db.meta.get(TODAY_META_KEY);
      const cached = parseMeta<TodayCache>(cachedRow?.value);
      if (
        cached &&
        cached.date === todayKey &&
        cached.itemCount === items.length &&
        cached.line
      ) {
        if (active) setLine(cached.line);
        return;
      }

      const recentRow = await db.meta.get(RECENT_META_KEY);
      const recent = parseMeta<RecentEntry[]>(recentRow?.value) ?? [];
      // 排除今天自己写下的那条，否则同一天藏品数变化时会把自己排除掉
      const recentKeys = recent
        .filter((entry) => entry.date !== todayKey)
        .slice(-RECENT_DAYS)
        .map((entry) => entry.key);

      const fact = pickInsightFact(items, today, recentKeys);
      if (!fact) {
        if (active) setLine(null);
        return;
      }

      // 降级基线：事实原文。模型只是让它更好听，不是让它成立。
      let text = fact.fact.replace(/[「」]/g, "");
      try {
        const response = await fetch("/api/insight", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: fact.fact }),
        });
        if (response.ok) {
          const result = (await response.json()) as { line?: string };
          if (result.line?.trim()) text = result.line.trim();
        }
      } catch {
        // 网络失败：保持事实原文，不打断首页
      }

      if (!active) return;
      setLine(text);

      await db.meta.put({
        key: TODAY_META_KEY,
        value: JSON.stringify({
          date: todayKey,
          itemCount: items.length,
          line: text,
          key: fact.key,
        } satisfies TodayCache),
      });

      const nextRecent = [
        ...recent.filter((entry) => entry.date !== todayKey),
        { date: todayKey, key: fact.key },
      ].slice(-(RECENT_DAYS + 1));
      await db.meta.put({
        key: RECENT_META_KEY,
        value: JSON.stringify(nextRecent),
      });
    })().catch(() => {
      // 读写本地库失败不该影响首页其它内容
      if (active) setLine(null);
    });

    return () => {
      active = false;
    };
  }, [items]);

  if (!line) return null;

  return (
    <p className="insight-line">
      <span className="insight-dot" aria-hidden="true" />
      {line}
    </p>
  );
}
