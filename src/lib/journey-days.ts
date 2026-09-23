// 旅途 = 一趟一趟的旅程，每趟由若干天组成，每天是一条路线（纯函数，旅途页和手帐页共用）。
//
// 一天的站点 = 手帐时间线上带照片的条目（配了图的段落 + 只拍没说的初见照片），按时间排好；
// 没有坐标的照片照样留在手帐里，只是不上地图。
// 连续的几天（间隔不超过 7 天、在同一个国家）算同一趟：英国 5 天是一趟，深圳两个周六也是一趟。
import type { JourneyCollageData } from "./journey-collage";
import { momentAnchor, photoAnchor, type DiaryTimelineItem } from "./memo/timeline";
import type { Item } from "./types";
import type { DiaryDay, Moment } from "./memo/types";

type StopItem = Pick<Item, "id" | "name" | "photo" | "place" | "country" | "lat" | "lng" | "date" | "userNote" | "ai">;

export interface DayStop {
  id: string;
  itemId: string;
  /** 手帐页里这一条的锚点 */
  anchor: string;
  at: string;
  name: string;
  /** 地点最后一段（「比奇角」） */
  spot: string;
  place: string;
  country: string;
  photo: string;
  lat: number | null;
  lng: number | null;
  /** 当时说的话 */
  quote: string;
  /** 一句话记忆 */
  line: string;
}

export interface JournalDay {
  dayKey: string;
  title: string;
  stops: DayStop[];
  country: string;
}

export interface JournalTrip {
  id: string;
  days: JournalDay[];
  /** 「英国」「深圳」 */
  label: string;
  /** 跨了几座城市：只有一座城的日常不画总览图 */
  cities: number;
}

const MAX_GAP_DAYS = 7;

export function placeParts(place: string): string[] {
  return place.split(/\s*[·・]\s*/).map((part) => part.trim()).filter(Boolean);
}

export function buildDayStops(input: { timeline: DiaryTimelineItem[]; moments: Moment[]; items: StopItem[] }): DayStop[] {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const momentById = new Map(input.moments.map((moment) => [moment.id, moment]));
  const stops: DayStop[] = [];
  for (const entry of input.timeline) {
    const itemId = entry.kind === "moment" ? entry.photoId : entry.itemId;
    const item = itemId ? itemById.get(itemId) : undefined;
    if (!item) continue;
    const moment = entry.kind === "moment" ? momentById.get(entry.momentId) : undefined;
    const parts = placeParts(item.place);
    stops.push({
      id: entry.kind === "moment" ? entry.momentId : `photo-${item.id}`,
      itemId: item.id,
      anchor: entry.kind === "moment" ? momentAnchor(entry.momentId) : photoAnchor(item.id),
      at: entry.at || item.date,
      name: item.name,
      spot: moment?.place?.name || parts.at(-1) || item.place,
      place: item.place,
      country: item.country,
      photo: item.photo,
      lat: item.lat,
      lng: item.lng,
      quote: moment?.myQuotes[0] || item.userNote || "",
      line: item.ai?.memorySentence || (entry.kind === "moment" ? entry.paragraph.text.slice(0, 40) : item.name),
    });
  }
  return stops;
}

function dayCountry(stops: DayStop[]): string {
  const counts = new Map<string, number>();
  for (const stop of stops) if (stop.country && stop.country !== "UNK") counts.set(stop.country, (counts.get(stop.country) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNK";
}

export function journalDay(diary: Pick<DiaryDay, "dayKey" | "title">, stops: DayStop[]): JournalDay {
  return { dayKey: diary.dayKey, title: diary.title, stops, country: dayCountry(stops) };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 按时间把天串成一趟趟旅程；返回最新的一趟在前，每趟内部按日期正序 */
export function groupTrips(days: JournalDay[]): JournalTrip[] {
  const sorted = [...days].sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
  const groups: JournalDay[][] = [];
  for (const day of sorted) {
    const current = groups.at(-1);
    const last = current?.at(-1);
    const sameCountry = !last || day.country === "UNK" || last.country === "UNK" || day.country === last.country;
    if (current && last && sameCountry && daysBetween(last.dayKey, day.dayKey) <= MAX_GAP_DAYS) current.push(day);
    else groups.push([day]);
  }
  return groups
    .map((group) => {
      const stops = group.flatMap((day) => day.stops);
      const cities = new Set(stops.map((stop) => placeParts(stop.place)[1] ?? placeParts(stop.place)[0]).filter(Boolean));
      const countries = new Set(stops.map((stop) => placeParts(stop.place)[0]).filter(Boolean));
      const label = cities.size === 1 ? [...cities][0] : countries.size === 1 ? [...countries][0] : `${countries.size} 个国家`;
      return { id: `trip-${group[0].dayKey}`, days: group, label: label || "旅途", cities: cities.size };
    })
    .reverse();
}

function mappable(stops: DayStop[]): (DayStop & { lat: number; lng: number })[] {
  return stops.filter((stop): stop is DayStop & { lat: number; lng: number } => typeof stop.lat === "number" && typeof stop.lng === "number");
}

function clock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function dotDate(dayKey: string): string {
  return dayKey.slice(5).replace("-", ".");
}

/** 两点间的大圆距离（公里） */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function routeKm(stops: { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 1; i < stops.length; i += 1) total += distanceKm(stops[i - 1], stops[i]);
  return total;
}

/** 一天的路线拼贴：每站一张照片、一张便签，序号按时间 */
export function dayCollage(day: JournalDay, timeZone: string): JourneyCollageData | null {
  const stops = mappable(day.stops);
  if (!stops.length) return null;
  return {
    id: `day-${day.dayKey}`,
    regions: [],
    mapLabel: day.title,
    stops: stops.map((stop, index) => ({
      id: stop.id,
      itemId: stop.itemId,
      date: clock(stop.at, timeZone),
      place: stop.spot,
      detail: stop.line,
      note: stop.quote,
      photo: stop.photo,
      coordinates: [stop.lng, stop.lat],
      hasDetectedSubject: false,
      href: `/memo/day/${day.dayKey}#${stop.anchor}`,
      label: `${clock(stop.at, timeZone)} · 第一次`,
      order: index + 1,
    })),
  };
}

/** 一趟旅程的总览：每天是一个点，连成这趟的路线 */
export function tripCollage(trip: JournalTrip, regions: JourneyCollageData["regions"]): JourneyCollageData | null {
  const days = trip.days
    .map((day) => ({ day, stops: mappable(day.stops) }))
    .filter((entry) => entry.stops.length);
  if (days.length < 2) return null;
  return {
    id: trip.id,
    regions,
    mapLabel: trip.label,
    stops: days.map(({ day, stops }, index) => {
      const lat = stops.reduce((sum, stop) => sum + stop.lat, 0) / stops.length;
      const lng = stops.reduce((sum, stop) => sum + stop.lng, 0) / stops.length;
      const cover = stops.find((stop) => stop.photo) ?? stops[0];
      const parts = placeParts(cover.place);
      return {
        id: `trip-day-${day.dayKey}`,
        itemId: cover.itemId,
        date: dotDate(day.dayKey),
        place: parts[1] && parts[1] !== trip.label ? parts[1] : cover.spot,
        detail: day.title,
        note: `${stops.length} 个地点 · ${stops.map((stop) => stop.spot).join(" → ")}`,
        photo: cover.photo,
        coordinates: [lng, lat],
        hasDetectedSubject: false,
        href: `/memo/day/${day.dayKey}`,
        label: `DAY ${index + 1} · ${dotDate(day.dayKey)}`,
        order: index + 1,
      };
    }),
  };
}
