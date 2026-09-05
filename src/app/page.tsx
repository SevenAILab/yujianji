"use client";

import { Camera, Compass, ImagePlus, PenLine, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { InsightLine } from "@/components/InsightLine";
import { ItemCard } from "@/components/ItemCard";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { MemoryGlobe, type MemoryGlobeApiPin, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { db, ensureSeeded } from "@/lib/db";
import { setPendingEncounterFile } from "@/lib/encounter-transfer";
import type { Item } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [seedReady, setSeedReady] = useState(false);
  const [mapResetToken, setMapResetToken] = useState(0);
  const [mapPins, setMapPins] = useState<MemoryGlobePin[]>([]);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );
  const [toast, setToast] = useState("");
  const [showEncounterMenu, setShowEncounterMenu] = useState(false);
  const encounterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const encounterCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!showEncounterMenu) {
      encounterTriggerRef.current?.focus();
      return;
    }
    encounterCloseRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setShowEncounterMenu(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showEncounterMenu]);

  function beginFileEncounter(file: File | undefined) {
    if (!file) return;
    setPendingEncounterFile(file);
    setShowEncounterMenu(false);
    router.push("/encounter");
  }

  useEffect(() => {
    if (!items.length) {
      setMapPins([]);
      return;
    }
    let active = true;
    fetch("/api/map-pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: items.map(({ photo: _photo, ai: _ai, ...item }) => item),
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("map pins failed");
        return response.json() as Promise<{
          pins: MemoryGlobeApiPin[];
        }>;
      })
      .then((result) => {
        if (!active) return;
        setMapPins(result.pins.map((pin) => ({
          ...pin,
          coverPhoto: items.find((item) => item.id === pin.coverItemId)?.photo ?? "",
          locations: pin.locations.map((location) => ({
            ...location,
            coverPhoto: items.find((item) => item.id === location.coverItemId)?.photo ?? "",
          })),
        })));
      })
      .catch(() => {
        if (active) setToast("地图地点暂时无法加载，请稍后重试。");
      });
    return () => { active = false; };
  }, [items]);

  useEffect(() => {
    let active = true;
    ensureSeeded()
      .then((inserted) => {
        if (active && inserted) {
          setToast("已载入示例历史。照片来自队员的真实旅行记录。");
          window.setTimeout(() => setToast(""), 3600);
        }
      })
      .catch(() => {
        if (active) setToast("示例历史加载失败，请刷新重试。");
      })
      .finally(() => {
        if (active) setSeedReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => {
    const firsts = items.filter((item) => item.ai?.verdict === "first");
    return {
      discovered: items.length,
      countries: new Set(
        items.filter((item) => item.country !== "UNK").map((item) => item.country),
      ).size,
      firsts: firsts.length,
    };
  }, [items]);

  const recent = [...items].reverse().slice(0, 4);

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <div className="brand-lockup">
            <h1>我的世界地图</h1>
            <span>YU JIAN JI</span>
          </div>
          <button
            className="icon-action"
            aria-label="重置地图视角"
            title="重置地图视角"
            onClick={() => setMapResetToken((token) => token + 1)}
          >
            <Compass size={18} />
          </button>
        </header>

        <InsightLine items={items} />

        <MapErrorBoundary>
          <MemoryGlobe key={mapResetToken} pins={mapPins} />
        </MapErrorBoundary>

        <section className="stats-grid" aria-label="遇见统计">
          <div className="stat-card">
            <strong>{stats.discovered}</strong>
            <span>发现总数</span>
          </div>
          <div className="stat-card">
            <strong>{stats.countries}</strong>
            <span>去过的国家</span>
          </div>
          <div className="stat-card">
            <strong>{stats.firsts}</strong>
            <span>我的第一次</span>
          </div>
        </section>

        <button
          className="primary-action home-action"
          ref={encounterTriggerRef}
          onClick={() => setShowEncounterMenu(true)}
        >
          <Plus size={19} />
          遇见
        </button>

        <div className="section-heading">
          <h2>最近遇见</h2>
          <span>{items.length} 件藏品</span>
        </div>
        {recent.length > 0 ? (
          <div className="item-grid">
            {recent.map((item) => <ItemCard item={item} key={item.id} />)}
          </div>
        ) : (
          <div className="surface empty-state">你的第一件遇见，会从这里开始。</div>
        )}

        <p className="privacy-note">
          照片存储在本机浏览器；视频只在本机拆成画面帧和音频后临时发送给百炼模型，原视频与应用服务端都不会保存。
        </p>
      </div>
      <div aria-hidden={showEncounterMenu || undefined}>
        <AppNav />
      </div>
      {showEncounterMenu ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowEncounterMenu(false);
          }}
        >
          <div
            className="encounter-menu"
            role="dialog"
            aria-modal="true"
            aria-labelledby="encounter-menu-title"
          >
            <div className="encounter-menu-head">
              <div>
                <p className="eyebrow">开始一条记录</p>
                <h2 id="encounter-menu-title">你想怎么留下它？</h2>
              </div>
              <button
                className="icon-action"
                ref={encounterCloseRef}
                aria-label="关闭遇见入口"
                onClick={() => setShowEncounterMenu(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="encounter-menu-actions">
              <label className="encounter-menu-action">
                <Camera size={22} />
                <span>拍摄</span>
                <small>打开相机，拍一张新的照片</small>
                <input
                  className="file-input"
                  type="file"
                  accept="image/*,video/*"
                  capture="environment"
                  onChange={(event) => beginFileEncounter(event.target.files?.[0])}
                />
              </label>
              <label className="encounter-menu-action">
                <ImagePlus size={22} />
                <span>从相册选</span>
                <small>从手机里挑一张已经拍好的照片</small>
                <input
                  className="file-input"
                  type="file"
                  accept="image/*,video/*"
                  onChange={(event) => beginFileEncounter(event.target.files?.[0])}
                />
              </label>
              <button
                className="encounter-menu-action"
                onClick={() => {
                  setShowEncounterMenu(false);
                  router.push("/encounter?mode=text");
                }}
              >
                <PenLine size={22} />
                <span>只写字</span>
                <small>没有照片，也可以记住这一刻</small>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
