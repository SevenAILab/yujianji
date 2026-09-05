"use client";

import { geoMercator, geoPath } from "d3-geo";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getPhotoPresentation, type JourneyCollageData } from "@/lib/journey-collage";
import { SmartPhotoCutout } from "@/components/SmartPhotoCutout";

const WIDTH = 420;
const HEIGHT = 640;
const photoSlots = ["photo-west", "photo-south", "photo-east", "photo-extra-one", "photo-extra-two"];
const noteSlots = ["note-west", "note-south", "note-east", "note-extra-one", "note-extra-two"];

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

export function JourneyCollageMap({ journey }: { journey: JourneyCollageData }) {
  const [activeStopId, setActiveStopId] = useState(journey.stops[0]?.id ?? "");
  const map = useMemo(() => {
    const selected: RegionFeature[] = journey.regions.map((region) => ({
      type: "Feature",
      properties: { id: region.id, name: region.name },
      geometry: region.geometry,
    }));
    if (!selected.length || !journey.stops.length) return null;
    const scope = { type: "FeatureCollection", features: selected } as const;
    const projection = geoMercator().fitExtent([[22, 48], [WIDTH - 22, HEIGHT - 70]], scope as never);
    const path = geoPath(projection);
    const points = journey.stops.map((stop) => projection(stop.coordinates) ?? [0, 0]);
    return { land: selected.map((region) => path(region as never) ?? ""), route: buildCurvedRoute(points), points };
  }, [journey]);

  if (!map) return null;

  return (
    <div className="real-journey-map" aria-label={`${journey.mapLabel}真实地理旅程地图`}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${journey.mapLabel}陆地轮廓与旅程轨迹`}>
        <defs>
          <pattern id={`map-dots-${journey.id}`} width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="#8eb5ad" opacity=".34" /></pattern>
          <filter id={`soft-map-shadow-${journey.id}`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#37756f" floodOpacity=".13" /></filter>
        </defs>
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
            style={{ zIndex: activeStopId === stop.id ? 24 : 3 + (index % 12), translate: `${stackLevel * 5}px ${stackLevel * 4}px` }}
            key={`photo-${stop.id}`}
            href={`/item/${stop.itemId}`}
            aria-label={`打开${stop.place}的照片详情`}
            onMouseEnter={() => setActiveStopId(stop.id)}
            onFocus={() => setActiveStopId(stop.id)}
          >
            <SmartPhotoCutout src={stop.photo} alt={`${stop.place}旅程照片`} mode={presentation} /><span className="photo-date">{stop.date}</span>
          </Link>
        );
      })}

      {journey.stops.map((stop, index) => (
        <button
          className={`map-sticky-note ${noteSlots[index % noteSlots.length]} ${activeStopId === stop.id ? "active" : ""}`}
          style={{ zIndex: activeStopId === stop.id ? 25 : 4 + (index % 12), translate: `${Math.floor(index / noteSlots.length) * -4}px ${Math.floor(index / noteSlots.length) * 5}px` }}
          key={`note-${stop.id}`}
          onClick={() => setActiveStopId(stop.id)}
        >
          <small>FIRST TIME · {stop.date}</small><strong>{stop.detail}</strong><p>{stop.note}</p>
        </button>
      ))}

      {map.points.map(([x, y], index) => {
        const stop = journey.stops[index];
        return (
          <button className={`map-location-marker ${activeStopId === stop.id ? "active" : ""}`} style={{ left: `${(x / WIDTH) * 100}%`, top: `${(y / HEIGHT) * 100}%` }} key={`marker-${stop.id}`} aria-label={`查看${stop.place}`} onClick={() => setActiveStopId(stop.id)}>
            <span className="map-location-dot" /><span className="map-location-name">{stop.place}</span>
          </button>
        );
      })}

      <div className="map-scale-label">{journey.mapLabel.toUpperCase()} · 一级行政区 / 局部旅程</div>
    </div>
  );
}
