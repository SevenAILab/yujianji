import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, loadDemoData, removeDemoData } from "../src/lib/db";
import { buildBackup } from "../src/lib/backup";

describe("演示展厅数据", () => {
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

  it("显式载入 25 组模拟手记，移除时保留用户自己的资料，备份排除演示内容", async () => {
    const count = await loadDemoData();
    expect(count).toBe(25);
    expect(await loadDemoData()).toBe(25);
    expect(await db.memoSessions.filter((session) => session.id.startsWith("demo-session-")).count()).toBe(25);
    expect(await db.utterances.filter((utterance) => utterance.sessionId.startsWith("demo-session-")).count()).toBe(25);
    expect(await db.moments.filter((moment) => moment.id.startsWith("demo-moment-")).count()).toBe(25);

    const demoDiaries = await db.diaryDays.filter((diary) => diary.paragraphs.some((paragraph) => paragraph.momentId.startsWith("demo-moment-"))).toArray();
    expect(demoDiaries).toHaveLength(25);
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
});
