"use client";

// 旅程总览图的陆地底纹：Natural Earth 1:50m 国界（world-atlas，公共领域）。
// 700 多 KB，只在真要画总览图时按需加载；只挑和这趟路线范围相交的国家。
import { geoBounds } from "d3-geo";
import { useEffect, useMemo, useState } from "react";
import type { JourneyCollageRegion } from "@/lib/journey-collage";

type Shape = JourneyCollageRegion & { bounds: [[number, number], [number, number]] };

let shapesPromise: Promise<Shape[]> | null = null;

function loadShapes(): Promise<Shape[]> {
  shapesPromise ??= Promise.all([import("world-atlas/countries-50m.json"), import("topojson-client")]).then(([worldModule, { feature }]) => {
    const world = (worldModule as { default?: unknown }).default ?? worldModule;
    const topology = world as Parameters<typeof feature>[0] & { objects: { countries: Parameters<typeof feature>[1] } };
    const collection = feature(topology, topology.objects.countries) as unknown as {
      features: { id?: string; properties?: { name?: string }; geometry: JourneyCollageRegion["geometry"] | null }[];
    };
    return collection.features
      .filter((f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
      .map((f, index) => ({
        id: `country-${f.id ?? index}`,
        name: f.properties?.name ?? "",
        country: String(f.id ?? ""),
        geometry: f.geometry!,
        bounds: geoBounds(f as never) as [[number, number], [number, number]],
      }));
  });
  return shapesPromise;
}

export function useCountryShapes(points: { lat: number | null; lng: number | null }[]): JourneyCollageRegion[] {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const valid = points.filter((p): p is { lat: number; lng: number } => typeof p.lat === "number" && typeof p.lng === "number");
  const key = valid.map((p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`).join(";");

  useEffect(() => {
    if (!key) return;
    let active = true;
    void loadShapes()
      .then((all) => active && setShapes(all))
      .catch(() => undefined); // 底纹加载失败就不画陆地，路线照样有
    return () => {
      active = false;
    };
  }, [key]);

  return useMemo(() => {
    if (!key || !shapes.length) return [];
    const lats = valid.map((p) => p.lat);
    const lngs = valid.map((p) => p.lng);
    const pad = 4;
    const west = Math.min(...lngs) - pad;
    const east = Math.max(...lngs) + pad;
    const south = Math.min(...lats) - pad;
    const north = Math.max(...lats) + pad;
    return shapes
      .filter(({ bounds: [[w, s], [e, n]] }) => (w <= e ? e >= west && w <= east : true) && n >= south && s <= north)
      .map(({ id, name, country, geometry }) => ({ id, name, country, geometry }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shapes]);
}
