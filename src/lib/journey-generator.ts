import { z } from "zod";
import { resolveAdmin1Region, type RegionGeometry } from "./admin1";

const categorySchema = z.enum(["animal", "plant", "mineral", "landscape", "sky", "food", "artifact", "other"]);

export const journeyGenerationItemSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(80),
  category: categorySchema,
  place: z.string().min(1).max(120),
  country: z.string().min(2).max(8),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  date: z.string().min(1).max(40),
  userNote: z.string().max(300),
  memorySentence: z.string().max(120).optional().default(""),
  verdict: z.enum(["first", "reunion"]).nullable().optional().default(null),
  cognition: z.string().max(400).optional().default(""),
});

export const journeyGenerationRequestSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: journeyGenerationItemSchema.array().max(300),
}).refine((value) => value.startDate <= value.endDate, { message: "开始日期不能晚于结束日期" });

export type JourneyGenerationItem = z.infer<typeof journeyGenerationItemSchema>;

export interface GeneratedJourneyStop {
  id: string;
  itemId: string;
  date: string;
  place: string;
  detail: string;
  note: string;
  coordinates: [number, number];
  hasDetectedSubject: boolean;
  recordCount: number;
  regionId: string;
}

export interface GeneratedJourneyRegion {
  id: string;
  name: string;
  country: string;
  geometry: RegionGeometry;
}

export interface GeneratedJourney {
  id: string;
  title: string;
  dateRange: string;
  recordCount: number;
  regions: GeneratedJourneyRegion[];
  mapLabel: string;
  stops: GeneratedJourneyStop[];
}

function distanceKm(a: JourneyGenerationItem, b: JourneyGenerationItem) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function hasDetectedSubject(item: JourneyGenerationItem) {
  if (["animal", "plant", "mineral", "food", "artifact"].includes(item.category)) return true;
  if (["landscape", "sky"].includes(item.category)) return false;
  return /人物|人像|游客|朋友|家人|孩子|建筑|物件|雕塑|车辆|动物|植物/i.test(`${item.name} ${item.cognition}`);
}

function seasonLabel(month: number) {
  if (month >= 3 && month <= 5) return "春日漫游";
  if (month >= 6 && month <= 8) return "盛夏行记";
  if (month >= 9 && month <= 11) return "秋日旅笺";
  return "冬日手帐";
}

export function generateJourney(input: z.infer<typeof journeyGenerationRequestSchema>): GeneratedJourney | null {
  const selected = input.items
    .filter((item) => {
      const date = item.date.slice(0, 10);
      return date >= input.startDate && date <= input.endDate;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!selected.length) return null;

  const groups: JourneyGenerationItem[][] = [];
  for (const item of selected) {
    const group = groups.find((candidate) => {
      const anchor = candidate[0];
      return (anchor.country === item.country && distanceKm(anchor, item) <= 18) || anchor.place.trim() === item.place.trim();
    });
    if (group) group.push(item);
    else groups.push([item]);
  }

  const resolvedByItem = new Map(selected.map((item) => [
    item.id,
    resolveAdmin1Region({ lat: item.lat, lng: item.lng, country: item.country }),
  ]));
  const regions = [...new Map(
    [...resolvedByItem.values()]
      .filter((region): region is NonNullable<typeof region> => Boolean(region))
      .map((region) => [region.id, {
        id: region.id,
        name: region.nameZh || region.name,
        country: region.country,
        geometry: region.geometry,
      }]),
  ).values()];
  const regionNames = regions.map((region) => region.name);
  const mapLabel = regionNames.length <= 2
    ? regionNames.join(" · ")
    : `${regionNames[0]}等${regionNames.length}个地区`;
  const month = Number(selected[0].date.slice(5, 7)) || 1;
  const title = `${mapLabel || selected[0].place.split(/[·・]/)[0].trim()} · ${seasonLabel(month)}`;

  return {
    id: `journey-${input.startDate}-${input.endDate}`,
    title,
    dateRange: `${input.startDate}—${input.endDate}`,
    recordCount: selected.length,
    regions,
    mapLabel: mapLabel || "Journey",
    stops: groups.map((group, index) => {
      const cover = group.find((item) => item.verdict === "first") ?? group[0];
      const region = resolvedByItem.get(cover.id);
      return {
        id: `stop-${index + 1}-${cover.id}`,
        itemId: cover.id,
        date: cover.date.slice(5, 10).replace("-", "."),
        place: cover.place,
        detail: cover.memorySentence || (cover.verdict === "first" ? `第一次遇见${cover.name}` : `再次遇见${cover.name}`),
        note: cover.userNote || cover.memorySentence || `在${cover.place}遇见${cover.name}。`,
        coordinates: [cover.lng, cover.lat],
        hasDetectedSubject: hasDetectedSubject(cover),
        recordCount: group.length,
        regionId: region?.id ?? "",
      };
    }),
  };
}

