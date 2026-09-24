"use client";

import { geoMercator, geoPath } from "d3-geo";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getPhotoPresentation, type JourneyCollageData } from "@/lib/journey-collage";
import { SmartPhotoCutout } from "@/components/SmartPhotoCutout";
import "@/app/journeys/journeys.css";

const WIDTH = 420;
const HEIGHT = 640;
const MARKER_GAP = 34;
const photoSlots = ["photo-west", "photo-south", "photo-east", "photo-extra-one", "photo-extra-two"];
const noteSlots = ["note-indigo", "note-moss", "note-indigo-frame", "note-moss-frame", "note-indigo-banner", "note-moss-banner"];

type RegionFeature = {
  type: "Feature";
  properties: { id: string; name: string };
  geometry: { type: string; coordinates: unknown };
};

function buildCurvedRoute(points: number[][]) {
  if (points.length < 2) return "";
  return points.slice(1).reduce((path, next, index) => {
    const previous = points[index];
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const bend = (index % 2 === 0 ? 1 : -1) * Math.min(54, Math.max(24, Math.hypot(dx, dy) * .22));
    return `${path} C ${previous[0] + dx * .38} ${previous[1] + dy * .18 + bend}, ${next[0] - dx * .38} ${next[1] - dy * .18 - bend}, ${next[0]} ${next[1]}`;
  }, `M ${points[0][0]} ${points[0][1]}`);
}

/**
 * 地点跨度太小（一天走几公里，甚至只有一个点）时，给取景框留出最小范围，
 * 不然 fitExtent 会把两个相距 200 米的点拉到画布两端。
 */
function stopsScope(stops: JourneyCollageData["stops"], minSpanDeg: number) {
  const lngs = stops.map((stop) => stop.coordinates[0]);
  const lats = stops.map((stop) => stop.coordinates[1]);
  const cx = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  const halfW = Math.max((Math.max(...lngs) - Math.min(...lngs)) / 2, minSpanDeg / 2);
  const halfH = Math.max((Math.max(...lats) - Math.min(...lats)) / 2, minSpanDeg / 2);
  return {
    type: "MultiPoint" as const,
    coordinates: [
      [cx - halfW, cy - halfH],
      [cx + halfW, cy + halfH],
    ],
  };
}

/**
 * 拼贴路线图。两种取景：
 * - regions（旧版按年份拼贴）：按一级行政区裁切。
 * - stops（每天一条路线 / 一趟旅程的每一天）：按地点本身取景，陆地只作底纹（可以没有）。
 */
export function JourneyCollageMap({
  journey,
  fit = "regions",
  compact = false,
  caption,
}: {
  journey: JourneyCollageData;
  fit?: "regions" | "stops";
  compact?: boolean;
  caption?: string;
}) {
  const [activeStopId, setActiveStopId] = useState(journey.stops[0]?.id ?? "");
  const map = useMemo(() => {
    const selected: RegionFeature[] = journey.regions.map((region) => ({
      type: "Feature",
      properties: { id: region.id, name: region.name },
      geometry: region.geometry,
    }));
    if (!journey.stops.length) return null;
    if (fit === "regions" && !selected.length) return null;
    const scope = fit === "stops" ? stopsScope(journey.stops, 0.012) : ({ type: "FeatureCollection", features: selected } as const);
    // 一天的路线：上下留出照片和便签的位置，点位集中在中间一条带里；右边留出地名标签的宽度
    const extent: [[number, number], [number, number]] = fit === "stops" ? [[56, 150], [WIDTH - 136, HEIGHT - 150]] : [[22, 48], [WIDTH - 22, HEIGHT - 70]];
    const projection = geoMercator().fitExtent(extent, scope as never);
    const path = geoPath(projection);
    // 同一天里相隔几百米的两站会叠在一起：按「圆点 + 地名」的整块标签检测碰撞，撞了就往下错开，
    // 保证每个序号和地名都看得见（示意图，不是测绘）
    const points: number[][] = [];
    const boxes: [number, number, number, number][] = [];
    const labelBox = (x: number, y: number, name: string): [number, number, number, number] => [x - 16, y - MARKER_GAP / 2, x - 16 + 46 + name.length * 11.5, y + MARKER_GAP / 2];
    const hits = (a: [number, number, number, number]) => boxes.some((b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]);
    for (const stop of journey.stops) {
      let [x, y] = projection(stop.coordinates) ?? [0, 0];
      for (let tries = 0; tries < 6 && hits(labelBox(x, y, stop.place)); tries += 1) y += MARKER_GAP;
      points.push([x, y]);
      boxes.push(labelBox(x, y, stop.place));
    }
    return { land: selected.map((region) => path(region as never) ?? ""), route: buildCurvedRoute(points), points };
  }, [journey, fit]);

  if (!map) return null;

  return (
    <div className={`real-journey-map ${compact ? "compact" : ""}`} aria-label={`${journey.mapLabel}旅程路线图`}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${journey.mapLabel}的路线`}>
        <defs>
          <pattern id={`map-dots-${journey.id}`} width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="#8eb5ad" opacity=".34" /></pattern>
          <filter id={`soft-map-shadow-${journey.id}`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#37756f" floodOpacity=".13" /></filter>
        </defs>
        {map.land.length ? null : <rect className="journey-paper-texture" width={WIDTH} height={HEIGHT} style={{ fill: `url(#map-dots-${journey.id})` }} />}
        {map.land.map((land, index) => <path className="journey-land" d={land} filter={`url(#soft-map-shadow-${journey.id})`} key={`land-${index}`} />)}
        {map.land.map((land, index) => <path className="journey-land-texture" d={land} style={{ fill: `url(#map-dots-${journey.id})` }} key={`texture-${index}`} />)}
        <path className="journey-route-under" d={map.route} />
        <path className="journey-route" d={map.route} />
      </svg>

      {journey.stops.map((stop, index) => {
        const presentation = getPhotoPresentation(stop.hasDetectedSubject);
        const stackLevel = Math.floor(index / photoSlots.length);
        return (
          <Link
            className={`map-photo-cutout ${presentation} ${photoSlots[index % photoSlots.length]} ${activeStopId === stop.id ? "active" : ""}`}
            style={{ zIndex: activeStopId === stop.id ? 32 : 14 + (index % 12), translate: `${stackLevel * 5}px ${stackLevel * 4}px` }}
            key={`photo-${stop.id}`}
            href={stop.href ?? `/item/${stop.itemId}`}
            aria-label={`打开${stop.place}的记录`}
            onMouseEnter={() => setActiveStopId(stop.id)}
            onFocus={() => setActiveStopId(stop.id)}
          >
            <SmartPhotoCutout src={stop.photo} alt={`${stop.place}的照片`} mode={presentation} /><span className="photo-date">{stop.date}</span>
          </Link>
        );
      })}

      {journey.stops.map((stop, index) => {
        const slot = index % noteSlots.length;
        const stackLevel = Math.floor(index / noteSlots.length);
        const anchoredRight = slot === 0 || slot === 2 || slot === 4;
        return (
          <button
            className={`map-sticky-note ${noteSlots[slot]} ${activeStopId === stop.id ? "active" : ""}`}
            style={{
              zIndex: activeStopId === stop.id ? 31 : 4 + (index % 10),
              translate: `${stackLevel * (anchoredRight ? -54 : 54)}px ${stackLevel * 48}px`,
            }}
            key={`note-${stop.id}`}
            onClick={() => setActiveStopId(stop.id)}
          >
            <small>{stop.label ?? `FIRST TIME · ${stop.date}`}</small><strong>{stop.detail}</strong><p>{stop.note}</p>
          </button>
        );
      })}

      {map.points.map(([x, y], index) => {
        const stop = journey.stops[index];
        return (
          <button className={`map-location-marker ${activeStopId === stop.id ? "active" : ""}`} style={{ left: `${(x / WIDTH) * 100}%`, top: `${(y / HEIGHT) * 100}%` }} key={`marker-${stop.id}`} aria-label={`查看${stop.place}`} onClick={() => setActiveStopId(stop.id)}>
            {stop.order ? <span className="map-location-order">{stop.order}</span> : <span className="map-location-dot" />}
            <span className="map-location-name">{stop.place}</span>
          </button>
        );
      })}

      <div className="map-scale-label">{caption ?? `${journey.mapLabel.toUpperCase()} · 一级行政区 / 局部旅程`}</div>
    </div>
  );
}
