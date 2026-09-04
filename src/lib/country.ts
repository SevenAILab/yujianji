"use client";

import { geoContains } from "d3-geo";
import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import { NUMERIC_TO_ALPHA3 } from "@/lib/iso";

const countries = feature(
  world as never,
  world.objects.countries as never,
) as unknown as {
  features: Array<{
    id?: string | number;
    geometry: { type: string; coordinates: unknown };
  }>;
};

export function detectCountryFromPosition(
  lat: number,
  lng: number,
): string | null {
  const point: [number, number] = [lng, lat];
  const match = countries.features.find((country) =>
    geoContains(country.geometry as never, point),
  );
  if (!match) return null;
  return NUMERIC_TO_ALPHA3[String(match.id ?? "").padStart(3, "0")] ?? null;
}
