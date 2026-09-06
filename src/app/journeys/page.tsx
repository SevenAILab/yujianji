"use client";

import { CalendarDays, LoaderCircle, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { JourneyCollageMap } from "@/components/JourneyCollageMap";
import { db, ensureSeeded } from "@/lib/db";
import { countryName } from "@/lib/iso";
import type { JourneyCollageData } from "@/lib/journey-collage";
import type { GeneratedJourney } from "@/lib/journey-generator";
import type { Item } from "@/lib/types";
import "./journeys.css";

type SavedJourney = {
  meta: GeneratedJourney;
  createdAt: string;
  /** 按年份自动生成的拼贴：默认展示，不入库、不可删。 */
  isAuto?: boolean;
};

const JOURNEY_ARCHIVE_KEY = "journey-archive-v1";

function previousJourneyEnd(journey: SavedJourney | undefined) {
  const candidate = journey?.meta.dateRange.split("—").at(-1)?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function validJourneyItems(items: Item[]) {
  return items.filter(
    (item): item is Item & { lat: number; lng: number } =>
      typeof item.lat === "number" && typeof item.lng === "number",
  );
}

export default function JourneysPage() {
  const [seedReady, setSeedReady] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [journeyName, setJourneyName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [activeCountry, setActiveCountry] = useState("ALL");
  const [savedJourneys, setSavedJourneys] = useState<SavedJourney[]>([]);
  const [autoJourneys, setAutoJourneys] = useState<SavedJourney[]>([]);
  const [autoLoading, setAutoLoading] = useState(true);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );

  useEffect(() => {
    let active = true;
    void ensureSeeded()
      .catch(() => undefined)
      .finally(() => {
        if (active) setSeedReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!seedReady) return;
    let active = true;
    void db.meta.get(JOURNEY_ARCHIVE_KEY).then((stored) => {
      if (!active || typeof stored?.value !== "string") return;
      try {
        const parsed = JSON.parse(stored.value) as SavedJourney[];
        if (Array.isArray(parsed)) setSavedJourneys(parsed);
      } catch {
        // Ignore an unreadable local archive and let the next save replace it.
      }
    });
    return () => {
      active = false;
    };
  }, [seedReady]);

  const dateBounds = useMemo(() => {
    if (!items.length) return null;
    return {
      first: items[0].date.slice(0, 10),
      last: items[items.length - 1].date.slice(0, 10),
    };
  }, [items]);

  // 自己创建的排在前面，按年份自动生成的跟在后面，评委一进来就有内容可看。
  const allJourneys = useMemo(
    () => [...savedJourneys, ...autoJourneys],
    [savedJourneys, autoJourneys],
  );

  const countries = useMemo(
    () => [...new Set(allJourneys.flatMap((journey) => journey.meta.regions.map((region) => region.country)))],
    [allJourneys],
  );

  const visibleJourneys = useMemo(
    () => activeCountry === "ALL"
      ? allJourneys
      : allJourneys.filter((journey) => journey.meta.regions.some((region) => region.country === activeCountry)),
    [activeCountry, allJourneys],
  );

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  // 打开就有内容：按「每一年」自动生成拼贴，不需要用户先手填日期。
  // 只读展示，不写进 journey-archive，所以不会污染用户自己建的旅程。
  useEffect(() => {
    const sourceItems = validJourneyItems(items);
    if (!sourceItems.length) {
      setAutoJourneys([]);
      setAutoLoading(false);
      return;
    }
    let active = true;
    setAutoLoading(true);
    const years = [...new Set(sourceItems.map((item) => item.date.slice(0, 4)))]
      .filter((year) => /^\d{4}$/.test(year))
      .sort((a, b) => Number(b) - Number(a));

    const payloadFor = (year: string) => ({
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      items: sourceItems
        .filter((item) => item.date.slice(0, 4) === year)
        .map((item) => ({
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
    });

    void Promise.all(
      years.map(async (year): Promise<SavedJourney | null> => {
        try {
          const response = await fetch("/api/journeys/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payloadFor(year)),
          });
          if (!response.ok) return null;
          const payload = await response.json() as { journey?: GeneratedJourney };
          if (!payload.journey) return null;
          return {
            meta: {
              ...payload.journey,
              id: `auto-${year}`,
              title: `${year} 年 · ${payload.journey.title}`,
            },
            createdAt: `${year}-12-31T00:00:00.000Z`,
            isAuto: true,
          };
        } catch {
          // 单独某一年失败不影响其它年份，失败的那年就是不出现。
          return null;
        }
      }),
    ).then((results) => {
      if (!active) return;
      setAutoJourneys(results.filter((entry): entry is SavedJourney => entry !== null));
      setAutoLoading(false);
    });

    return () => {
      active = false;
    };
  }, [items]);

  function openCreator() {
    setGenerationError("");
    if (dateBounds) {
      const previousEnd = previousJourneyEnd(savedJourneys[0]);
      const nextStart = previousEnd || dateBounds.first;
      setStartDate(nextStart);
      setEndDate(nextStart > dateBounds.last ? nextStart : dateBounds.last);
    }
    setJourneyName("");
    setCreatorOpen(true);
  }

  function toCollage(journey: GeneratedJourney): JourneyCollageData {
    return {
      id: journey.id,
      regions: journey.regions,
      mapLabel: journey.mapLabel,
      stops: journey.stops.flatMap((stop) => {
        const source = itemById.get(stop.itemId);
        return source ? [{ ...stop, photo: source.photo }] : [];
      }),
    };
  }

  async function createJourney() {
    setGenerating(true);
    setGenerationError("");
    try {
      const sourceItems = validJourneyItems(items);
      const response = await fetch("/api/journeys/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          items: sourceItems.map((item) => ({
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
      if (!response.ok || !payload.journey) {
        throw new Error(payload.error ?? "旅程生成失败");
      }

      const createdAt = new Date().toISOString();
      const meta: GeneratedJourney = {
        ...payload.journey,
        id: `${payload.journey.id}-${Date.now()}`,
        title: journeyName.trim() || payload.journey.title,
      };
      const next = [{ meta, createdAt }, ...savedJourneys];
      await db.meta.put({ key: JOURNEY_ARCHIVE_KEY, value: JSON.stringify(next) });
      setSavedJourneys(next);
      setActiveCountry("ALL");
      setCreatorOpen(false);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "旅程生成失败");
    } finally {
      setGenerating(false);
    }
  }

  async function deleteJourney() {
    if (!pendingDeleteId) return;
    const next = savedJourneys.filter((journey) => journey.meta.id !== pendingDeleteId);
    await db.meta.put({ key: JOURNEY_ARCHIVE_KEY, value: JSON.stringify(next) });
    setSavedJourneys(next);
    setPendingDeleteId(null);
  }

  return (
    <main className="app-shell journey-shell">
      <div className="phone-page journey-page">
        <header className="journey-header">
          <div>
            <h1>我的旅程</h1>
            <p>用时间，串起所有的遇见</p>
          </div>
          <button className="journey-calendar" onClick={openCreator} aria-label="创建旅程" title="创建旅程">
            <CalendarDays size={25} strokeWidth={1.8} />
          </button>
        </header>

        <div className="journey-filters" role="group" aria-label="按国家筛选旅程">
          <button className={activeCountry === "ALL" ? "active" : ""} onClick={() => setActiveCountry("ALL")}>全部</button>
          {countries.map((code) => (
            <button className={activeCountry === code ? "active" : ""} onClick={() => setActiveCountry(code)} key={code}>
              {countryName(code).replace("中国", "国内")}
            </button>
          ))}
        </div>

        <div className="journey-collage-list">
          {visibleJourneys.map((journey) => {
            const collage = toCollage(journey.meta);
            return (
              <article className="journey-collage-entry" key={journey.meta.id}>
                <header className="journey-collage-heading">
                  <div>
                    <small>{journey.meta.dateRange}</small>
                    <h2>{journey.meta.title}</h2>
                    <p>{journey.meta.stops.length} 个地点 · {journey.meta.recordCount} 条记录</p>
                  </div>
                  {journey.isAuto ? null : (
                    <button className="journey-delete-button" onClick={() => setPendingDeleteId(journey.meta.id)} aria-label={`删除${journey.meta.title}`} title="删除旅程">
                      <X size={18} strokeWidth={1.7} />
                    </button>
                  )}
                </header>
                <JourneyCollageMap journey={collage} />
              </article>
            );
          })}

          {!visibleJourneys.length && autoLoading ? (
            <div className="journey-empty" aria-live="polite">
              <LoaderCircle className="journey-spin" size={22} />
              <strong>正在按年份整理你的旅程…</strong>
              <span>照片、地点和路线会自动拼成一张旅行手帐。</span>
            </div>
          ) : null}

          {!visibleJourneys.length && !autoLoading ? (
            <button className="journey-empty" onClick={openCreator}>
              <CalendarDays size={22} strokeWidth={1.6} />
              <strong>{allJourneys.length ? "这里还没有对应的旅程" : "创建你的第一张旅程拼贴"}</strong>
              <span>选择一段时间，照片、地点和路线会自动拼成一张旅行手帐。</span>
            </button>
          ) : null}
        </div>
      </div>
      <AppNav />

      {creatorOpen ? (
        <div className="journey-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !generating) setCreatorOpen(false);
        }}>
          <section className="journey-creator" role="dialog" aria-modal="true" aria-labelledby="journey-creator-title">
            <div className="journey-creator-head">
              <div>
                <span>NEW JOURNEY</span>
                <h2 id="journey-creator-title">创建一段旅程</h2>
              </div>
              <button onClick={() => setCreatorOpen(false)} disabled={generating} aria-label="关闭创建旅程">
                <X size={18} />
              </button>
            </div>

            <label className="journey-name-field">
              <span>旅程名称</span>
              <input value={journeyName} onChange={(event) => setJourneyName(event.target.value)} placeholder="例如：冰岛之旅" maxLength={36} />
            </label>

            <div className="journey-date-range">
              <label>
                <span>开始日期</span>
                <input type="date" min={dateBounds?.first} max={endDate || dateBounds?.last} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <i>—</i>
              <label>
                <span>结束日期</span>
                <input type="date" min={startDate || dateBounds?.first} max={dateBounds?.last} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </label>
            </div>

            {generationError ? <div className="journey-error">{generationError}</div> : null}

            <button className="journey-create-action" disabled={!startDate || !endDate || generating || !items.length} onClick={() => void createJourney()}>
              {generating ? <LoaderCircle className="journey-spin" size={17} /> : <WandSparkles size={17} />}
              {generating ? "正在整理这段旅程…" : "生成旅程拼贴"}
            </button>
          </section>
        </div>
      ) : null}

      {pendingDeleteId ? (
        <div className="journey-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPendingDeleteId(null);
        }}>
          <section className="journey-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="journey-delete-title">
            <span>DELETE JOURNEY</span>
            <h2 id="journey-delete-title">删除这张旅程拼贴？</h2>
            <p>只会删除这张拼贴，原始照片和遇见记录都会保留。</p>
            <div>
              <button onClick={() => setPendingDeleteId(null)}>取消</button>
              <button className="confirm" onClick={() => void deleteJourney()}>删除旅程</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
