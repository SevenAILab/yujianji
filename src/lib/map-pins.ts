import { z } from "zod";
import { resolveAdmin1Region, type RegionGeometry } from "./admin1";

const coordinatePrecisionSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const mapPinSourceSchema = z.object({
  id: z.string().min(1).max(120),
  locationId: z.string().min(1).max(160).optional(),
  regionId: z.string().min(1).max(160).optional(),
  place: z.string().min(1).max(120),
  country: z.string().min(2).max(5),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  date: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  userNote: z.string().max(300).default(""),
});

export const mapPinsRequestSchema = z.object({
  items: z.array(mapPinSourceSchema).max(1_000),
  coordinatePrecision: coordinatePrecisionSchema.default(3),
  bounds: z
    .object({
      west: z.number().finite().min(-180).max(180),
      south: z.number().finite().min(-90).max(90),
      east: z.number().finite().min(-180).max(180),
      north: z.number().finite().min(-90).max(90),
    })
    .refine((bounds) => bounds.south <= bounds.north, {
      message: "south must not exceed north",
    })
    .optional(),
});

export type MapPinSource = z.infer<typeof mapPinSourceSchema>;
export type MapPinsRequest = z.infer<typeof mapPinsRequestSchema>;

export interface MapPinLocation {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
}

export interface MapPin {
  id: string;
  location: MapPinLocation;
  region: {
    id: string;
    name: string;
    country: string;
    center: [number, number];
    geometry: RegionGeometry;
  } | null;
  locations: Array<
    MapPinLocation & {
      itemIds: string[];
      coverItemId: string;
      latestDate: string;
      preview: Array<{
        id: string;
        name: string;
        date: string;
        note: string;
      }>;
    }
  >;
  memoryCount: number;
  itemIds: string[];
  coverItemId: string;
  latestDate: string;
  preview: Array<{
    id: string;
    name: string;
    date: string;
    note: string;
  }>;
}

function normalizePart(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}

export function deriveLocationId(
  item: Pick<MapPinSource, "locationId" | "country" | "place" | "lat" | "lng">,
  coordinatePrecision = 3,
): string {
  if (item.locationId) return item.locationId;
  return [
    "loc",
    normalizePart(item.country),
    normalizePart(item.place),
    item.lat.toFixed(coordinatePrecision),
    item.lng.toFixed(coordinatePrecision),
  ].join(":");
}

function isInsideBounds(
  item: MapPinSource,
  bounds: NonNullable<MapPinsRequest["bounds"]>,
): boolean {
  const insideLatitude = item.lat >= bounds.south && item.lat <= bounds.north;
  const insideLongitude =
    bounds.west <= bounds.east
      ? item.lng >= bounds.west && item.lng <= bounds.east
      : item.lng >= bounds.west || item.lng <= bounds.east;
  return insideLatitude && insideLongitude;
}

export function buildMapPins(input: MapPinsRequest): MapPin[] {
  const candidates = input.bounds
    ? input.items.filter((item) => isInsideBounds(item, input.bounds!))
    : input.items;
  const groups = new Map<string, { region: ReturnType<typeof resolveAdmin1Region>; items: MapPinSource[] }>();

  for (const item of candidates) {
    const region = resolveAdmin1Region(item);
    const key = region?.id ?? deriveLocationId(item, input.coordinatePrecision);
    const current = groups.get(key);
    groups.set(key, { region, items: [...(current?.items ?? []), item] });
  }

  return [...groups.entries()]
    .map(([groupId, group]) => {
      const { region, items } = group;
      const ordered = [...items].sort(
        (a, b) => Date.parse(b.date) - Date.parse(a.date),
      );
      const anchor = ordered[0];
      const lat = items.reduce((sum, item) => sum + item.lat, 0) / items.length;
      const lng = items.reduce((sum, item) => sum + item.lng, 0) / items.length;

      const locationGroups = new Map<string, MapPinSource[]>();
      items.forEach((item) => {
        const id = deriveLocationId(item, input.coordinatePrecision);
        locationGroups.set(id, [...(locationGroups.get(id) ?? []), item]);
      });
      const locations = [...locationGroups.entries()].map(([id, locationItems]) => {
        const locationOrdered = [...locationItems].sort(
          (a, b) => Date.parse(b.date) - Date.parse(a.date),
        );
        const latest = locationOrdered[0];
        return {
          id,
          name: latest.place,
          country: latest.country.toUpperCase(),
          lat: locationItems.reduce((sum, item) => sum + item.lat, 0) / locationItems.length,
          lng: locationItems.reduce((sum, item) => sum + item.lng, 0) / locationItems.length,
          itemIds: locationOrdered.map((item) => item.id),
          coverItemId: latest.id,
          latestDate: latest.date,
          preview: locationOrdered.slice(0, 3).map((item) => ({
            id: item.id,
            name: item.name,
            date: item.date,
            note: item.userNote,
          })),
        };
      });

      return {
        id: region ? `region:${region.id}` : `pin:${groupId}`,
        location: {
          id: groupId,
          name: region?.nameZh || region?.name || anchor.place,
          country: anchor.country.toUpperCase(),
          lat: region?.center[1] ?? lat,
          lng: region?.center[0] ?? lng,
        },
        region: region ? {
          id: region.id,
          name: region.nameZh || region.name,
          country: region.country,
          center: region.center,
          geometry: region.geometry,
        } : null,
        locations,
        memoryCount: ordered.length,
        itemIds: ordered.map((item) => item.id),
        coverItemId: anchor.id,
        latestDate: anchor.date,
        preview: ordered.slice(0, 3).map((item) => ({
          id: item.id,
          name: item.name,
          date: item.date,
          note: item.userNote,
        })),
      } satisfies MapPin;
    })
    .sort((a, b) => Date.parse(b.latestDate) - Date.parse(a.latestDate));
}
