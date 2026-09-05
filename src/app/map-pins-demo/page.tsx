"use client";

import { useEffect, useState } from "react";
import { MemoryGlobe, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { localMapPins } from "@/lib/local-map-pins";
import type { Item } from "@/lib/types";

export default function MapPinsDemoPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [pins, setPins] = useState<MemoryGlobePin[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const seedResponse = await fetch("/seed-data.json", { cache: "no-store" });
        const seedItems = (await seedResponse.json()) as Item[];
        setItems(seedItems);
        setPins(localMapPins(seedItems));
      } catch {
        setError("地图 Pin 暂时无法加载");
      }
    }
    void load();
  }, []);

  return (
    <main style={{ minHeight: "100vh", padding: "28px 18px 48px", background: "#f7f5ed" }}>
      <section style={{ width: "min(1040px, 100%)", margin: "0 auto" }}>
        <p style={{ margin: 0, color: "#6c887f", fontSize: 12, letterSpacing: ".18em" }}>
          MAP PINS · LOCAL DEMO
        </p>
        <h1 style={{ margin: "8px 0 6px", color: "#17675f", fontSize: 32 }}>地点长成记忆 Pin</h1>
        <p style={{ margin: "0 0 22px", color: "#68807b", lineHeight: 1.7 }}>
          地图读取内置示例记录，在本机聚合地点，不上传位置。
        </p>

        {error ? <p>{error}</p> : null}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(280px, .7fr)", gap: 18 }}>
          <MemoryGlobe pins={pins} />
          <aside style={{ maxHeight: 560, overflow: "auto", padding: 16, border: "1px solid #d6dfd8", borderRadius: 18, background: "rgba(255,255,255,.72)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <strong style={{ color: "#17675f" }}>本机聚合的地点</strong>
              <small style={{ color: "#86a16b" }}>{pins.length} 个 Pin</small>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {pins.map((pin) => (
                <article key={pin.id} style={{ display: "grid", gridTemplateColumns: "58px 1fr", gap: 11, padding: 9, borderRadius: 13, background: "#fffdf7", border: "1px solid #e2e5dc" }}>
                  <img src={pin.coverPhoto} alt="" style={{ width: 58, height: 58, objectFit: "cover", borderRadius: 9 }} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", color: "#285f58", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pin.location.name}</strong>
                    <small style={{ color: "#7b8d86" }}>{pin.memoryCount} 条遇见 · {pin.location.lat.toFixed(2)}, {pin.location.lng.toFixed(2)}</small>
                    <p style={{ margin: "5px 0 0", color: "#4f736d", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {pin.preview[0]?.note || pin.preview[0]?.name}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
