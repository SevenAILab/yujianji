"use client";

import { CalendarRange, LoaderCircle, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { JourneyCollageMap } from "@/components/JourneyCollageMap";
import { db, ensureSeeded } from "@/lib/db";
import type { GeneratedJourney } from "@/lib/journey-generator";
import type { JourneyCollageData } from "@/lib/journey-collage";
import type { Item } from "@/lib/types";
import "./journeys.css";

export default function JourneysPage() {
  const [seedReady, setSeedReady] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [generated, setGenerated] = useState<{ meta: GeneratedJourney; collage: JourneyCollageData } | null>(null);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );

  useEffect(() => {
    let active = true;
    void ensureSeeded().catch(() => undefined).finally(() => { if (active) setSeedReady(true); });
    return () => { active = false; };
  }, []);

  const dateBounds = useMemo(() => {
    if (!items.length) return null;
    return { first: items[0].date.slice(0, 10), last: items[items.length - 1].date.slice(0, 10) };
  }, [items]);

  useEffect(() => {
    if (!dateBounds || startDate || endDate) return;
    const latest = new Date(`${dateBounds.last}T00:00:00`);
    const start = new Date(latest);
    start.setDate(start.getDate() - 30);
    const suggestedStart = start.toISOString().slice(0, 10);
    setStartDate(suggestedStart < dateBounds.first ? dateBounds.first : suggestedStart);
    setEndDate(dateBounds.last);
  }, [dateBounds, endDate, startDate]);

  async function generateSelectedJourney() {
    setGenerating(true);
    setGenerationError("");
    try {
      const response = await fetch("/api/journeys/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          items: items.map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category,
            place: item.place,
            country: item.country,
            lat: item.lat,
            lng: item.lng,
            date: item.date,
            userNote: item.userNote,
            memorySentence: item.ai?.memorySentence ?? "",
            verdict: item.ai?.verdict ?? null,
            cognition: item.ai?.cognition ?? "",
          })),
        }),
      });
      const payload = await response.json() as { journey?: GeneratedJourney; error?: string };
      if (!response.ok || !payload.journey) throw new Error(payload.error ?? "旅程生成失败");
      const byId = new Map(items.map((item) => [item.id, item]));
      const collage: JourneyCollageData = {
        id: payload.journey.id,
        regions: payload.journey.regions,
        mapLabel: payload.journey.mapLabel,
        stops: payload.journey.stops.flatMap((stop) => {
          const source = byId.get(stop.itemId);
          return source ? [{ ...stop, photo: source.photo }] : [];
        }),
      };
      setGenerated({ meta: payload.journey, collage });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "旅程生成失败");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="app-shell journey-shell">
      <div className="phone-page journey-page">
        <header className="journey-header"><p className="eyebrow">TRAVEL ARCHIVE · 2024</p><h1>我的旅程</h1><p>用时间，串起所有的遇见</p></header>

        <section className="journey-builder surface">
          <div className="journey-builder-heading"><span><CalendarRange size={16} /></span><div><strong>生成一段旅程</strong><small>选择你想重新翻开的时间</small></div></div>
          <div className="journey-date-range">
            <label>从<input type="date" min={dateBounds?.first} max={endDate || dateBounds?.last} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
            <span>—</span>
            <label>到<input type="date" min={startDate || dateBounds?.first} max={dateBounds?.last} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
          </div>
          <button className="primary-action journey-generate-action" disabled={!startDate || !endDate || generating || !items.length} onClick={() => void generateSelectedJourney()}>
            {generating ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
            {generating ? "正在整理旅程…" : "生成手帐地图"}
          </button>
          {generationError ? <div className="error-box">{generationError}</div> : null}
        </section>

        {generated ? (
          <section className="journey-entry generated-journey is-open">
            <div className="journey-title-row generated-title-row">
              <span><small>{generated.meta.dateRange}</small><strong>{generated.meta.title}</strong><em>{generated.meta.stops.length} 个地点 · {generated.meta.recordCount} 条记录</em></span>
            </div>
            <JourneyCollageMap journey={generated.collage} />
          </section>
        ) : null}

        {!generated ? <div className="journey-coming-soon"><span>选择时间，翻开一段旅程</span><p>地图会自动裁切到这段旅程涉及的一级行政区。</p></div> : null}
      </div>
      <AppNav />
    </main>
  );
}
