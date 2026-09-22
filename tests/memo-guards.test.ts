import { describe, expect, it } from "vitest";
import { applyGuards, type GuardUtterance } from "../src/lib/memo/guards";
import type { ModelMoment } from "../src/lib/memo/schema";

const window: GuardUtterance[] = [
  { id: "s:0", offsetMs: 0, speaker: "other", text: "他们四点就下班了，下了班是真的不回消息。" },
  { id: "s:1", offsetMs: 3000, speaker: "me", text: "真的假的？" },
  { id: "s:2", offsetMs: 6000, speaker: "me", text: "我们那边加班到十点都算正常，感觉这边的人把生活放在前面。" },
  { id: "s:3", offsetMs: 9000, speaker: "uncertain", text: "这边的人走路都不赶时间。" },
  { id: "s:4", offsetMs: 12000, speaker: "me", text: "嗯。" },
];

function m(partial: Partial<ModelMoment>): ModelMoment {
  return { sourceUtteranceIds: ["s:2"], decision: "keep", category: "difference", salience: 0.8, trigger: "下班时间", why: "你注意到了差异", ...partial };
}

describe("代码守卫", () => {
  it("G1：来源句子不在本窗口 → 丢弃并记 error", () => {
    const r = applyGuards([m({ sourceUtteranceIds: ["s:2", "x:9"] })], { mode: "session", utterances: window });
    expect(r.moments).toHaveLength(0);
    expect(r.events[0]).toMatchObject({ code: "G1", kind: "error" });
  });

  it("G2：keep 的来源里没有我、也没有拿不准 → drop / others_only，不保存原话", () => {
    const r = applyGuards([m({ sourceUtteranceIds: ["s:0"] })], { mode: "session", utterances: window });
    expect(r.moments[0]).toMatchObject({ decision: "drop", category: "others_only", myQuotes: [] });
    expect(r.events.some((e) => e.code === "G2")).toBe(true);
  });

  it("只有朋友在说的窗口，端到端结果是 drop", () => {
    const friendOnly: GuardUtterance[] = [
      { id: "f:0", offsetMs: 0, speaker: "other", text: "这座教堂修了两百年，里面的彩窗是后来补的。" },
      { id: "f:1", offsetMs: 4000, speaker: "other", text: "我上次来的时候还在维修。" },
    ];
    const r = applyGuards([m({ sourceUtteranceIds: ["f:0", "f:1"], category: "retold_fact" })], { mode: "session", utterances: friendOnly });
    expect(r.moments[0].decision).toBe("drop");
  });

  it("G2U：来源只有拿不准的句子 → 最多 fold，标 speakerUncertain，原话放 uncertainQuotes（不和 G2 冲突）", () => {
    const r = applyGuards([m({ sourceUtteranceIds: ["s:3"], category: "observation" })], { mode: "session", utterances: window });
    expect(r.moments[0]).toMatchObject({ decision: "fold", speakerUncertain: true, myQuotes: [], uncertainQuotes: ["这边的人走路都不赶时间。"] });
  });

  it("G2U：模型已经判 fold 的拿不准片段保持 fold，可捞回", () => {
    const r = applyGuards([m({ sourceUtteranceIds: ["s:3"], decision: "fold", category: "observation" })], { mode: "session", utterances: window });
    expect(r.moments[0]).toMatchObject({ decision: "fold", speakerUncertain: true });
  });

  it("G3：丢类却判 keep → fold", () => {
    const r = applyGuards([m({ category: "complaint" })], { mode: "session", utterances: window });
    expect(r.moments[0].decision).toBe("fold");
  });

  it("G4：myQuotes 由代码按 id 取我的原文，按时间排序，不含别人的话", () => {
    const r = applyGuards([m({ sourceUtteranceIds: ["s:2", "s:0", "s:1"] })], { mode: "session", utterances: window });
    expect(r.moments[0].myQuotes).toEqual(["真的假的？", "我们那边加班到十点都算正常，感觉这边的人把生活放在前面。"]);
  });

  it("G5：补一段置信度 < 0.6 → 不自动挂回，让用户选", () => {
    const r = applyGuards([m({ backfillTarget: { dayKey: "2026-09-22", place: "海德公园", confidence: 0.4 } })], { mode: "backfill", utterances: window });
    expect(r.moments[0].needsPlacePick).toBe(true);
    const ok = applyGuards([m({ backfillTarget: { dayKey: "2026-09-22", place: "海德公园", confidence: 0.8 } })], { mode: "backfill", utterances: window });
    expect(ok.moments[0].needsPlacePick).toBe(false);
  });

  it("G8：与已保留片段完全重复 → 丢弃（保留 salience 高的）", () => {
    const r = applyGuards([m({ salience: 0.6 }), m({ salience: 0.9, trigger: "更重要" })], { mode: "session", utterances: window });
    expect(r.moments).toHaveLength(1);
    expect(r.moments[0].trigger).toBe("更重要");
  });

  it("G9：转述照抄他人原话 → 移除；带引号 → 去引号", () => {
    const copied = applyGuards([m({ sourceUtteranceIds: ["s:0", "s:2"], othersParaphrase: "朋友说他们四点就下班了，下了班是真的不回消息" })], { mode: "session", utterances: window });
    expect(copied.moments[0].othersParaphrase).toBeUndefined();
    const quoted = applyGuards([m({ sourceUtteranceIds: ["s:0", "s:2"], othersParaphrase: "朋友说“那边早下班”" })], { mode: "session", utterances: window });
    expect(quoted.moments[0].othersParaphrase).toBe("朋友说那边早下班");
  });

  it("LEN：trigger / why 超过 30 字截断", () => {
    const r = applyGuards([m({ why: "一".repeat(50) })], { mode: "session", utterances: window });
    expect([...r.moments[0].why].length).toBe(30);
  });

  describe("G10：配图", () => {
    const photos = { mode: "session" as const, utterances: window, photoCandidateIds: ["item_a", "item_b"] };

    it("候选里的图正常配上", () => {
      const r = applyGuards([m({ photoId: "item_a" })], photos);
      expect(r.moments[0].photoId).toBe("item_a");
    });

    it("不在候选里的图 → 丢掉并记 G10", () => {
      const r = applyGuards([m({ photoId: "item_x" })], photos);
      expect(r.moments[0].photoId).toBeUndefined();
      expect(r.events.some((e) => e.code === "G10")).toBe(true);
    });

    it("drop 的片段不配图", () => {
      const r = applyGuards([m({ decision: "drop", category: "others_only", photoId: "item_a" })], photos);
      expect(r.moments[0].photoId).toBeUndefined();
      expect(r.events.some((e) => e.code === "G10")).toBe(true);
    });

    it("同一张图只给 salience 更高的那段，另一段留白", () => {
      const r = applyGuards(
        [
          m({ sourceUtteranceIds: ["s:2"], salience: 0.5, photoId: "item_a" }),
          m({ sourceUtteranceIds: ["s:1"], salience: 0.9, photoId: "item_a", category: "observation" }),
        ],
        photos,
      );
      const withPhoto = r.moments.filter((x) => x.photoId === "item_a");
      expect(withPhoto).toHaveLength(1);
      expect(withPhoto[0].salience).toBe(0.9);
    });

    it("这一轮没有候选时，任何 photoId 都不生效", () => {
      const r = applyGuards([m({ photoId: "item_a" })], { mode: "session", utterances: window });
      expect(r.moments[0].photoId).toBeUndefined();
    });

    it("reflection 讲的是心里的事，不配图（实测踩过：植物照片配到了悬崖的反思上）", () => {
      const r = applyGuards([m({ category: "reflection", photoId: "item_a" })], photos);
      expect(r.moments[0].photoId).toBeUndefined();
      expect(r.events.some((e) => e.code === "G10")).toBe(true);
    });

    it("memory / retold_fact 同样不配图", () => {
      for (const category of ["memory", "retold_fact"] as const) {
        const r = applyGuards([m({ category, photoId: "item_a" })], photos);
        expect(r.moments[0].photoId).toBeUndefined();
      }
    });

    it("observation / first_experience / difference 才配图", () => {
      for (const category of ["observation", "first_experience", "difference"] as const) {
        const r = applyGuards([m({ category, photoId: "item_a" })], photos);
        expect(r.moments[0].photoId).toBe("item_a");
      }
    });
  });
});
