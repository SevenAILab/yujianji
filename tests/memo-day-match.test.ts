import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDayMatches, dayMatchSignature, remainingAfter, selectDayMatchInput } from "../src/lib/memo/day-match";
import type { Item } from "../src/lib/types";
import type { Moment } from "../src/lib/memo/types";

const api = vi.hoisted(() => ({ match: vi.fn(), write: vi.fn() }));
vi.mock("../src/lib/memo/client/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/memo/client/api")>();
  return { ...original, memoApi: { ...original.memoApi, match: api.match, write: api.write } };
});

const DAY = "2026-09-23";
const TZ = "Asia/Shanghai";
// 北京时间当天中午前后，任何常见时区都落在同一天
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 23, hour - 8, minute)).toISOString();

function moment(id: string, patch: Partial<Moment> = {}): Moment {
  return {
    id,
    sessionId: "s1",
    windowId: "w1",
    dayKey: DAY,
    at: at(12),
    decision: "keep",
    salience: 0.7,
    category: "observation",
    trigger: "看到一杯咖啡",
    why: "第一次",
    myQuotes: ["这杯瑞幸的杯子居然是蓝色的"],
    sourceUtteranceIds: ["u1"],
    user: { copiedCount: 0 },
    runId: "run_x",
    profileVersion: 1,
    createdAt: at(12),
    ...patch,
  };
}

function item(id: string, patch: Partial<Item> = {}): Item {
  return {
    id,
    name: "瑞幸咖啡杯",
    category: "food",
    photo: "data:image/jpeg;base64,AAAA",
    place: "深圳 · 南山",
    country: "CHN",
    lat: null,
    lng: null,
    locationSource: "none",
    date: at(12, 5),
    userNote: "",
    ai: { cognition: "", fun: "", luck: "", question: "", verdict: "first", relatedItemId: null, memorySentence: "" },
    isSeed: false,
    createdAt: at(12, 5),
    ...patch,
  } as unknown as Item;
}

describe("日终补配图 · 选输入", () => {
  it("只补 keep、能配图的类别、还没有图的片段", () => {
    const input = selectDayMatchInput({
      dayKey: DAY,
      timeZone: TZ,
      moments: [
        moment("keep"),
        moment("reflect", { category: "reflection" }),
        moment("fold", { decision: "fold" }),
        moment("judged", { photoId: "p_old" }),
        moment("deleted", { user: { copiedCount: 0, decision: "drop" } }),
      ],
      items: [item("p1")],
    });
    expect(input.moments.map((m) => m.id)).toEqual(["keep"]);
  });

  it("judge 配过的图不进候选；用户删掉的段落释放它的图", () => {
    const input = selectDayMatchInput({
      dayKey: DAY,
      timeZone: TZ,
      moments: [
        moment("a", { photoId: "p_taken" }),
        moment("b", { photoId: "p_released", user: { copiedCount: 0, decision: "drop" } }),
        moment("c"),
      ],
      items: [item("p_taken"), item("p_released"), item("p_free")],
    });
    expect(input.photos.map((p) => p.id).sort()).toEqual(["p_free", "p_released"]);
  });

  it("示例照片、别的日子的照片、日期坏掉的照片都不进候选", () => {
    const input = selectDayMatchInput({
      dayKey: DAY,
      timeZone: TZ,
      moments: [moment("a")],
      items: [item("seed", { isSeed: true }), item("yesterday", { date: "2026-09-22T04:00:00.000Z" }), item("broken", { date: "not-a-date" }), item("ok")],
    });
    expect(input.photos.map((p) => p.id)).toEqual(["ok"]);
  });

  it("不上传图片本身：候选里只有名称、类别、地点、时间", () => {
    const input = selectDayMatchInput({ dayKey: DAY, timeZone: TZ, moments: [moment("a")], items: [item("p1")] });
    expect(Object.keys(input.photos[0]).sort()).toEqual(["category", "id", "name", "place", "time"]);
    expect(JSON.stringify(input)).not.toContain("base64");
  });
});

describe("日终补配图 · 代码守卫", () => {
  const input = {
    moments: [
      { id: "low", at: at(12), salience: 0.5, time: "12:00", place: "", category: "observation" as const, trigger: "", quote: "" },
      { id: "high", at: at(13), salience: 0.9, time: "13:00", place: "", category: "observation" as const, trigger: "", quote: "" },
    ],
    photos: [
      { id: "p1", name: "咖啡杯", category: "food", place: "", time: "12:05" },
      { id: "p2", name: "盆栽", category: "plant", place: "", time: "12:10" },
    ],
  };

  it("候选外的照片、待补列表外的片段都丢掉", () => {
    const r = applyDayMatches(input, {
      matches: [
        { momentId: "high", photoId: "p_fake", reason: "" },
        { momentId: "ghost", photoId: "p1", reason: "" },
      ],
    });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
  });

  it("一张图只给一段：salience 高的先拿", () => {
    const r = applyDayMatches(input, {
      matches: [
        { momentId: "low", photoId: "p1", reason: "" },
        { momentId: "high", photoId: "p1", reason: "" },
      ],
    });
    expect(r.accepted).toEqual([{ momentId: "high", photoId: "p1", reason: "" }]);
  });

  it("一段只配一张", () => {
    const r = applyDayMatches(input, {
      matches: [
        { momentId: "high", photoId: "p1", reason: "" },
        { momentId: "high", photoId: "p2", reason: "" },
      ],
    });
    expect(r.accepted.map((a) => a.photoId)).toEqual(["p1"]);
  });

  it("签名与顺序无关，但内容变化也会触发重新匹配；补完之后剩余集合变了签名也变", () => {
    const reversed = { moments: [...input.moments].reverse(), photos: [...input.photos].reverse() };
    expect(dayMatchSignature(reversed)).toBe(dayMatchSignature(input));
    expect(dayMatchSignature({
      ...input,
      photos: input.photos.map((photo, index) => index === 0 ? { ...photo, name: "改过的照片名" } : photo),
    })).not.toBe(dayMatchSignature(input));
    const rest = remainingAfter(input, [{ momentId: "high", photoId: "p1", reason: "" }]);
    expect(rest.moments.map((m) => m.id)).toEqual(["low"]);
    expect(rest.photos.map((p) => p.id)).toEqual(["p2"]);
    expect(dayMatchSignature(rest)).not.toBe(dayMatchSignature(input));
  });
});

describe("日终生成手帐（本地库 + 接口隔离）", () => {
  beforeEach(async () => {
    const { db } = await import("../src/lib/db");
    await Promise.all([db.items.clear(), db.moments.clear(), db.diaryDays.clear(), db.memoSessions.clear(), db.agentTraces.clear()]);
    api.match.mockReset();
    api.write.mockReset();
    api.write.mockImplementation(async (body: { moments: { id: string }[] }) => ({
      title: "测试手帐",
      quotes: [],
      paragraphs: body.moments.map((m) => ({ momentId: m.id, heading: "12:00 · 深圳", text: "写好的段落", verified: true, degraded: false, retries: 0 })),
      trace: { runId: "w_test_run", scope: "write", refId: DAY, startedAt: at(12), ms: 1, costYuan: 0, outcome: "ok", steps: [] },
    }));
  });

  async function seed(opts: { photos?: boolean; moments?: boolean }) {
    const { db } = await import("../src/lib/db");
    await db.memoSessions.put({ id: "s1", timeZone: TZ, status: "ready" } as never);
    if (opts.moments) await db.moments.put(moment("m1"));
    if (opts.photos) await db.items.put(item("p1"));
  }

  it("先录后拍：日终补上配图，写进片段", async () => {
    await seed({ photos: true, moments: true });
    api.match.mockResolvedValue({ matches: [{ momentId: "m1", photoId: "p1", reason: "说的就是这杯咖啡" }], trace: { runId: "m_run_1", scope: "match", refId: DAY, startedAt: at(12), ms: 1, costYuan: 0, outcome: "ok", steps: [] } });
    const { generateDiary } = await import("../src/lib/memo/client/orchestrator");
    const { db } = await import("../src/lib/db");
    const diary = await generateDiary(DAY);
    expect(api.match).toHaveBeenCalledTimes(1);
    expect((await db.moments.get("m1"))?.photoId).toBe("p1");
    expect((await db.moments.get("m1"))?.photoSource).toBe("day_match");
    expect(diary.photoMatch?.outcome).toBe("ok");
    expect(diary.paragraphs).toHaveLength(1);
  });

  it("重复生成不重复花钱：剩余集合没变就不再调模型", async () => {
    await seed({ photos: true, moments: true });
    api.match.mockResolvedValue({ matches: [], trace: { runId: "m_run_2", scope: "match", refId: DAY, startedAt: at(12), ms: 1, costYuan: 0, outcome: "ok", steps: [] } });
    const { generateDiary } = await import("../src/lib/memo/client/orchestrator");
    await generateDiary(DAY);
    await generateDiary(DAY);
    expect(api.match).toHaveBeenCalledTimes(1);
  });

  it("同一天并发点生成只执行一次匹配和写作", async () => {
    await seed({ photos: false, moments: true });
    const { generateDiary } = await import("../src/lib/memo/client/orchestrator");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    api.write.mockImplementation(async (body: { moments: { id: string }[] }) => {
      entered();
      await gate;
      return {
        title: "并发测试手帐",
        quotes: [],
        paragraphs: body.moments.map((m) => ({ momentId: m.id, heading: "12:00 · 深圳", text: "写好的段落", verified: true, degraded: false, retries: 0 })),
        trace: { runId: "w_concurrent", scope: "write", refId: DAY, startedAt: at(12), ms: 1, costYuan: 0, outcome: "ok", steps: [] },
      };
    });
    const first = generateDiary(DAY);
    const second = generateDiary(DAY);
    await started;
    expect(api.write).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(api.write).toHaveBeenCalledTimes(1);
  });

  it("配图失败不拦写手帐，下次生成会重试", async () => {
    await seed({ photos: true, moments: true });
    api.match.mockRejectedValue(new Error("网络断了"));
    const { generateDiary } = await import("../src/lib/memo/client/orchestrator");
    const diary = await generateDiary(DAY);
    expect(diary.paragraphs).toHaveLength(1);
    expect(diary.photoMatch?.outcome).toBe("failed");
    await generateDiary(DAY);
    expect(api.match).toHaveBeenCalledTimes(2);
  });

  it("只拍照没说话的日子也能生成，不调任何模型", async () => {
    await seed({ photos: true });
    const { generateDiary } = await import("../src/lib/memo/client/orchestrator");
    const diary = await generateDiary(DAY);
    expect(diary.paragraphs).toEqual([]);
    expect(diary.photoMatch?.outcome).toBe("skipped");
    expect(api.match).not.toHaveBeenCalled();
    expect(api.write).not.toHaveBeenCalled();
  });
});

describe("日终补配图 · 提示词", () => {
  it("百炼的 JSON 输出模式要求提示词里出现 json 字样（真实调用踩过：InvalidParameter）", async () => {
    const { MATCH_SYSTEM } = await import("../src/lib/memo/prompts/match");
    expect(MATCH_SYSTEM.toLowerCase()).toContain("json");
  });
});
