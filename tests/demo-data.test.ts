import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, ensureSeeded, loadDemoData, removeDemoData } from "../src/lib/db";
import { DEMO_DAYS, DEMO_VERSION } from "../src/lib/demo/journal-demo";
import { buildBackup } from "../src/lib/backup";

describe("示例手帐数据", () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    const userItem = {
      id: "mine-1", name: "自己的照片", category: "landscape", photo: "data:image/jpeg;base64,AAAA", place: "深圳", country: "CHN",
      lat: null, lng: null, locationSource: "none", date: "2026-08-01T12:00:00.000Z", userNote: "自己的记录", ai: null, isSeed: false,
      createdAt: "2026-08-01T12:00:00.000Z",
    };
    await db.items.put(userItem as never);
    await db.diaryDays.put({
      dayKey: "2026-08-01", title: "自己的手帐", quotes: [], paragraphs: [], foldedMomentIds: [], profileVersion: 1,
      generatedAt: "2026-08-01T12:00:00.000Z", runId: "user-run", status: "ready",
    });
    const seedJson = readFileSync("public/seed-data.json", "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(seedJson, { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("按天载入示例路线（每站一张照片 + 一段原话 + 一段手帐），移除时保留用户自己的资料，备份排除示例", async () => {
    const stops = DEMO_DAYS.reduce((sum, day) => sum + day.stops.length, 0);
    const asides = DEMO_DAYS.reduce((sum, day) => sum + (day.asides?.length ?? 0), 0);
    const count = await loadDemoData();
    expect(count).toBe(stops);
    expect(await loadDemoData()).toBe(stops);
    expect(await db.memoSessions.filter((session) => session.id.startsWith("demo-session-")).count()).toBe(stops + asides);
    expect(await db.utterances.filter((utterance) => utterance.sessionId.startsWith("demo-session-")).count()).toBe(stops + asides);
    expect(await db.moments.filter((moment) => moment.id.startsWith("demo-moment-")).count()).toBe(stops + asides);
    // 写进手帐的每一站都配着自己那张照片，理由各不相同；折叠/丢掉的片段不配图
    const demoMoments = await db.moments.filter((moment) => moment.id.startsWith("demo-moment-")).toArray();
    const kept = demoMoments.filter((moment) => moment.decision === "keep");
    expect(kept).toHaveLength(stops);
    expect(kept.every((moment) => moment.photoId && moment.id === `demo-moment-${moment.photoId}`)).toBe(true);
    expect(new Set(kept.map((moment) => moment.why)).size).toBe(stops);
    expect(demoMoments.filter((moment) => moment.decision !== "keep").every((moment) => !moment.photoId)).toBe(true);
    const cliffs = await db.diaryDays.get("2026-09-13");
    expect(cliffs?.foldedMomentIds).toEqual(["demo-moment-demo-aside-cliffs-sheep"]);
    // 旧版 25 张散落的示例照片不再载入，只保留全景
    expect(await db.items.get("tabby-cat-2017-03")).toBeUndefined();

    const demoDiaries = await db.diaryDays.filter((diary) => diary.paragraphs.some((paragraph) => paragraph.momentId.startsWith("demo-moment-"))).toArray();
    expect(demoDiaries).toHaveLength(DEMO_DAYS.length);
    expect(demoDiaries.every((diary) => diary.paragraphs.length >= 3)).toBe(true);
    expect(demoDiaries.some((diary) => diary.dayKey === "2026-08-01")).toBe(false);
    const mixed = demoDiaries[0];
    const demoMoment = await db.moments.get(mixed.paragraphs[0].momentId);
    expect(demoMoment).toBeDefined();
    await db.moments.put({ ...demoMoment!, id: "mine-moment", runId: "mine-run", myQuotes: ["自己的原话"] });
    await db.diaryDays.put({
      ...mixed,
      title: "用户补充的手帐",
      paragraphs: [...mixed.paragraphs, { momentId: "mine-moment", heading: "自己的标题", text: "自己的手记", verified: true, degraded: false, retries: 0 }],
      quotes: [...mixed.quotes, { momentId: "mine-moment", text: "自己的原话" }],
    });

    const backup = await buildBackup();
    expect(backup.items.map((item) => item.id)).toEqual(["mine-1"]);
    expect(backup.memo?.sessions).toHaveLength(0);
    expect(backup.memo?.moments.map((moment) => (moment as { id: string }).id)).toEqual(["mine-moment"]);
    expect(backup.memo?.diaryDays).toHaveLength(2);
    const backedUpMixedDiary = backup.memo?.diaryDays.find((diary) => (diary as { title: string }).title === "用户补充的手帐") as { paragraphs: { momentId: string }[] } | undefined;
    expect(backedUpMixedDiary?.paragraphs.map((paragraph) => paragraph.momentId)).toEqual(["mine-moment"]);

    await removeDemoData();
    expect(await db.memoSessions.filter((session) => session.id.startsWith("demo-session-")).count()).toBe(0);
    expect(await db.moments.filter((moment) => moment.id.startsWith("demo-moment-")).count()).toBe(0);
    expect(await db.moments.get("mine-moment")).toBeDefined();
    expect(await db.items.get("mine-1")).toBeDefined();
    expect((await db.diaryDays.get("2026-08-01"))?.title).toBe("自己的手帐");
    const remaining = await db.diaryDays.toArray();
    expect(remaining).toHaveLength(2);
    expect(remaining.find((diary) => diary.title === "用户补充的手帐")?.paragraphs.map((paragraph) => paragraph.momentId)).toEqual(["mine-moment"]);
  });

  it("已经载入旧版示例的设备，打开时整套换成新版路线示例，用户那天自己的手帐不动", async () => {
    await db.items.put({ id: "tabby-cat-2017-03", name: "窗边虎斑猫", category: "animal", photo: "/seed/cat.jpg", place: "英国 · 伦敦", country: "GBR", lat: 51.5, lng: -0.1, locationSource: "manual", date: "2017-03-18T16:45:00+00:00", userNote: "", ai: null, isSeed: true, createdAt: "2017-03-18T16:45:00+00:00" } as never);
    await db.meta.put({ key: "demo-loaded", value: true });
    await db.diaryDays.put({ dayKey: "2026-09-13", title: "用户自己的白崖", quotes: [], paragraphs: [], foldedMomentIds: [], profileVersion: 1, generatedAt: "2026-09-13T12:00:00.000Z", runId: "user-run-2", status: "ready" });

    expect(await ensureSeeded()).toBe(true);
    expect(await db.items.get("tabby-cat-2017-03")).toBeUndefined();
    expect((await db.meta.get("demo-version"))?.value).toBe(DEMO_VERSION);
    expect((await db.diaryDays.get("2026-09-13"))?.title).toBe("用户自己的白崖");
    expect(await db.diaryDays.get("2026-09-12")).toBeDefined();
    expect(await ensureSeeded()).toBe(false);
  });
});
