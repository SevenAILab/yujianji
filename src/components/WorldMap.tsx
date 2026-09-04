"use client";

import { geoNaturalEarth1, geoPath } from "d3-geo";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { MapPin, Move3d } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import { useRouter } from "next/navigation";
import world from "world-atlas/countries-110m.json";
import { NUMERIC_TO_ALPHA3 } from "@/lib/iso";
import type { Item } from "@/lib/types";

const WIDTH = 800;
const HEIGHT = 430;

interface CountryFeature {
  type: "Feature";
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

export function WorldMap({ items }: { items: Item[] }) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [selectedPin, setSelectedPin] = useState<Item[] | null>(null);

  const countries = useMemo(
    () =>
      feature(
        world as never,
        world.objects.countries as never,
      ) as unknown as { features: CountryFeature[] },
    [],
  );
  const projection = useMemo(
    () =>
      geoNaturalEarth1().fitExtent(
        [
          [18, 18],
          [WIDTH - 18, HEIGHT - 18],
        ],
        countries as never,
      ),
    [countries],
  );
  const pathGenerator = useMemo(() => geoPath(projection), [projection]);
  const visitedCountries = useMemo(
    () => new Set(items.map((item) => item.country)),
    [items],
  );
  const pins = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    items.forEach((item) => {
      const key = `${item.lat.toFixed(1)}:${item.lng.toFixed(1)}`;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    });
    return [...grouped.values()]
      .map((group) => {
        const first = group[0];
        const point = projection([first.lng, first.lat]);
        return point ? { group, point } : null;
      })
      .filter((value): value is { group: Item[]; point: [number, number] } => Boolean(value));
  }, [items, projection]);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) return;
    const svg = select(svgElement);
    const mapGroup = svg.select<SVGGElement>(".map-zoom");
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .on("zoom", (event) => {
        mapGroup.attr("transform", event.transform.toString());
      });

    svg.call(behavior);
    svg.call(behavior.transform, zoomIdentity);
    return () => {
      svg.on(".zoom", null);
    };
  }, []);

  return (
    <div className="map-card surface">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="遇见集世界地图"
      >
        <rect className="map-water" x="0" y="0" width={WIDTH} height={HEIGHT} rx="17" />
        <g className="map-zoom">
          <g>
            {countries.features.map((country, index) => {
              const numeric = String(country.id ?? "").padStart(3, "0");
              const alpha3 = NUMERIC_TO_ALPHA3[numeric];
              const d = pathGenerator(country as never);
              return d ? (
                <path
                  className={`country ${alpha3 && visitedCountries.has(alpha3) ? "visited" : ""}`}
                  d={d}
                  key={`${numeric}-${index}`}
                />
              ) : null;
            })}
          </g>
          <g>
            {pins.map(({ group, point }) => {
              const [x, y] = point;
              return (
                <g
                  className="pin-group"
                  key={`${group[0].lat}-${group[0].lng}`}
                  onClick={() => {
                    if (group.length === 1) {
                      router.push(`/item/${group[0].id}`);
                    } else {
                      setSelectedPin(group);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      if (group.length === 1) router.push(`/item/${group[0].id}`);
                      else setSelectedPin(group);
                    }
                  }}
                >
                  <circle className="pin" cx={x} cy={y} r="9" />
                  <circle className="pin-core" cx={x} cy={y} r="4" />
                  {group.length > 1 ? (
                    <text className="pin-label" x={x + 12} y={y + 4}>
                      {group.length}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <span className="map-hint">
        <Move3d size={13} />
        拖动或双指缩放
      </span>
      {selectedPin ? (
        <div className="map-sheet">
          <div className="map-sheet-head">
            <strong>{selectedPin[0].place}</strong>
            <button className="icon-action" onClick={() => setSelectedPin(null)} aria-label="关闭地点列表">
              ×
            </button>
          </div>
          {selectedPin.map((item) => (
            <button
              className="map-sheet-item"
              key={item.id}
              onClick={() => router.push(`/item/${item.id}`)}
            >
              <img src={item.photo} alt="" />
              <span>
                <strong>{item.name}</strong>
                <small>{item.date.slice(0, 10)}</small>
              </span>
              <MapPin size={15} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
