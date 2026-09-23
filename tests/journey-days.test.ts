import { describe, expect, it } from "vitest";
import { dayCollage, groupTrips, journalDay, routeKm, tripCollage, type DayStop } from "../src/lib/journey-days";
import { DEMO_DAYS } from "../src/lib/demo/journal-demo";

function stopsOf(dayKey: string): DayStop[] {
  const day = DEMO_DAYS.find((d) => d.dayKey === dayKey)!;
  return day.stops.map((stop) => ({
    id: `demo-moment-${stop.id}`,
    itemId: stop.id,
    anchor: `m-demo-moment-${stop.id}`,
    at: `${dayKey}T${stop.time}:00.000Z`,
    name: stop.name,
    spot: stop.place.split(" · ").at(-1)!,
    place: stop.place,
    country: stop.country,
    photo: stop.photo,
    lat: stop.lat,
    lng: stop.lng,
    quote: stop.quote,
    line: stop.memorySentence,
  }));
}

describe("旅途：一天一条路线，连续几天一趟旅程", () => {
  const days = DEMO_DAYS.map((day) => journalDay(day, stopsOf(day.dayKey)));

  it("英国 5 天是一趟、深圳两个周六是一趟，最新的一趟在前", () => {
    const trips = groupTrips(days);
    expect(trips.map((trip) => `${trip.label}:${trip.days.length}`)).toEqual(["英国:5", "深圳:2"]);
    expect(trips[0].days.map((day) => day.dayKey)).toEqual(["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(trips[0].cities).toBe(5);
    expect(trips[1].cities).toBe(1);
  });

  it("间隔超过 7 天或换了国家就拆成两趟", () => {
    const london = journalDay({ dayKey: "2026-09-12", title: "伦敦" }, stopsOf("2026-09-12"));
    const later = journalDay({ dayKey: "2026-10-01", title: "还是伦敦" }, stopsOf("2026-09-12"));
    const shenzhen = journalDay({ dayKey: "2026-09-13", title: "深圳" }, stopsOf("2026-07-11"));
    expect(groupTrips([london, later])).toHaveLength(2);
    expect(groupTrips([london, shenzhen])).toHaveLength(2);
  });

  it("一天的路线按时间编号，照片点进去回到手帐里那一段；总览里每天是一个点", () => {
    const whiteCliffs = dayCollage(days.find((day) => day.dayKey === "2026-09-13")!, "UTC")!;
    expect(whiteCliffs.stops.map((stop) => `${stop.order}${stop.place}`)).toEqual(["1西福德角", "2伯灵峡", "3比奇角"]);
    expect(whiteCliffs.stops[2].href).toBe("/memo/day/2026-09-13#m-demo-moment-demo-uk-lighthouse");
    expect(Math.round(routeKm(stopsOf("2026-09-13") as { lat: number; lng: number }[]))).toBeGreaterThan(5);

    const uk = tripCollage(groupTrips(days)[0], [])!;
    expect(uk.stops.map((stop) => stop.place)).toEqual(["伦敦", "七姐妹白崖", "牛津", "惠特比", "爱丁堡"]);
    expect(uk.stops[1].href).toBe("/memo/day/2026-09-13");
    // 深圳两天也能连成线；页面按 cities（只有一座城）决定不画总览，直接看每天的路线
    expect(tripCollage(groupTrips(days)[1], [])?.stops).toHaveLength(2);
  });

  it("没有坐标的照片留在手帐里，但不上地图", () => {
    const noGps = journalDay({ dayKey: "2026-09-20", title: "没定位" }, stopsOf("2026-09-12").map((stop) => ({ ...stop, lat: null, lng: null })));
    expect(dayCollage(noGps, "UTC")).toBeNull();
  });
});
