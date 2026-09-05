import regionsData from "../data/admin1-regions.json";

export type RegionGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface Admin1Region {
  id: string;
  country: string;
  name: string;
  nameZh: string;
  center: [number, number];
  bbox: [number, number, number, number];
  geometry: RegionGeometry;
}

const regions = regionsData as unknown as Admin1Region[];
const regionsById = new Map(regions.map((region) => [region.id, region]));

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng: number, lat: number, polygon: number[][][]): boolean {
  if (!polygon[0] || !pointInRing(lng, lat, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(lng, lat, hole));
}

export function regionContains(region: Admin1Region, lat: number, lng: number): boolean {
  const [west, south, east, north] = region.bbox;
  if (lng < west || lng > east || lat < south || lat > north) return false;
  return region.geometry.type === "Polygon"
    ? pointInPolygon(lng, lat, region.geometry.coordinates)
    : region.geometry.coordinates.some((polygon) => pointInPolygon(lng, lat, polygon));
}

export function resolveAdmin1Region({
  lat,
  lng,
  country,
  regionId,
}: {
  lat: number;
  lng: number;
  country?: string;
  regionId?: string;
}): Admin1Region | null {
  if (regionId) return regionsById.get(regionId) ?? null;
  const normalizedCountry = country?.toUpperCase();
  const exact = regions.find(
      (region) =>
        (!normalizedCountry || normalizedCountry === "UNK" || region.country === normalizedCountry) &&
        regionContains(region, lat, lng),
    );
  if (exact) return exact;

  // Coastal GPS coordinates can sit just outside a simplified shoreline. In that
  // case, select the nearest same-country Admin-1 bounding box within ~80 km.
  const nearby = regions
    .filter(
      (region) =>
        !normalizedCountry || normalizedCountry === "UNK" || region.country === normalizedCountry,
    )
    .map((region) => {
      const [west, south, east, north] = region.bbox;
      const dx = lng < west ? west - lng : lng > east ? lng - east : 0;
      const dy = lat < south ? south - lat : lat > north ? lat - north : 0;
      return { region, distance: Math.hypot(dx, dy) };
    })
    .sort((a, b) => a.distance - b.distance)[0];
  return nearby && nearby.distance <= 0.75 ? nearby.region : null;
}

export function getAdmin1Region(regionId: string): Admin1Region | null {
  return regionsById.get(regionId) ?? null;
}
