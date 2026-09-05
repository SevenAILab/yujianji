"use client";

import { Compass, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { ItemCard } from "@/components/ItemCard";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { MemoryGlobe, type MemoryGlobeApiPin, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { db, ensureSeeded } from "@/lib/db";
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

        <button className="primary-action home-action" onClick={() => router.push("/encounter")}>
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
          照片存储在本机浏览器；识别期间会临时发送给百炼模型，应用服务端不保存照片。
        </p>
      </div>
      <AppNav />
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
