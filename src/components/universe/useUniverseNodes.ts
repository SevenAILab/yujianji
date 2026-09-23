"use client";

// 记忆宇宙的节点来源（工单 Gate 4.1）：本地初见藏品 + 吉米的模型清单；本地一个都没有才退回示例。
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { db, hasDemoData } from "@/lib/db";
import { itemDayKey } from "@/lib/memo/day-match";
import { deviceTimeZone } from "@/lib/memo/time";
import { buildUniverseNodes, parseManifest, sampleNodes, type ModelEntry, type UniverseNode } from "@/lib/universe/nodes";

const MANIFEST_URL = "/assets/models/manifest.json";
const SAMPLE_URL = "/assets/encounters.json";

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // 文件不存在、JSON 坏了：当作没有
  }
}

export function useUniverseNodes(): { nodes: UniverseNode[]; loading: boolean; sample: boolean; demo: boolean } {
  const [timeZone] = useState(() => (typeof window === "undefined" ? "Asia/Shanghai" : deviceTimeZone()));
  const [manifest, setManifest] = useState<Map<string, ModelEntry> | null>(null);
  const [samples, setSamples] = useState<UniverseNode[] | null>(null);

  useEffect(() => {
    void fetchJson(MANIFEST_URL).then((raw) => setManifest(parseManifest(raw)));
  }, []);

  const demoLoaded = useLiveQuery(() => hasDemoData(), [], false);
  const items = useLiveQuery(
    async () => (await db.items.toArray()).filter((item) => (!item.isSeed || demoLoaded) && item.ai?.verdict === "first"),
    [demoLoaded],
  );
  const days = useMemo(() => [...new Set((items ?? []).map((item) => itemDayKey(item, timeZone)).filter((d): d is string => Boolean(d)))].sort(), [items, timeZone]);
  const moments = useLiveQuery(() => (days.length ? db.moments.where("dayKey").anyOf(days).toArray() : []), [days.join(",")]);
  const diaries = useLiveQuery(() => db.diaryDays.toArray(), []);
  const visibleMomentIds = useMemo(
    () => new Set((diaries ?? []).flatMap((diary) => diary.paragraphs.map((paragraph) => paragraph.momentId))),
    [diaries],
  );

  const built = useMemo(
    () => (items && moments && manifest ? buildUniverseNodes({ items, moments, manifest, timeZone, includeSeeds: Boolean(demoLoaded), visibleMomentIds }) : null),
    [items, moments, manifest, timeZone, demoLoaded, visibleMomentIds],
  );

  useEffect(() => {
    if (built && !built.length && samples === null) void fetchJson(SAMPLE_URL).then((raw) => setSamples(sampleNodes(raw)));
  }, [built, samples]);

  const sample = Boolean(built && !built.length);
  const current = sample ? (samples ?? []) : (built ?? []);
  // 场景按节点重建，代价不小：只有节点本身变了（id、跳转目标、模型）才换新数组
  const key = current.map((n) => `${n.id}|${n.href ?? ""}|${n.model?.glbUrl ?? ""}|${n.color ?? ""}`).join(";");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nodes = useMemo(() => current, [key]);
  const loading = !built || (sample && samples === null);
  return { nodes, loading, sample, demo: Boolean(demoLoaded) && !sample };
}
