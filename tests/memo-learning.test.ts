import { describe, expect, it } from "vitest";
import { applyFeedback } from "../src/lib/memo/feedback";
import { applyReflectOps, seedProfile, selectLearnedExamples, validateReflectOps } from "../src/lib/memo/learning";
import { buildMemoryIndex, recallMemory } from "../src/lib/memo/memory-index";
import type { FeedbackEvent, Moment, ProfileRule } from "../src/lib/memo/types";

const now = "2026-09-23T02:00:00Z";

function rule(id: string, partial: Partial<ProfileRule> = {}): ProfileRule {
  return { id, kind: "drop", text: "功能性事务丢", origin: "seed", locked: false, evidenceMomentIds: [], active: true, createdAt: now, updatedAt: now, ...partial };
}

function moment(id: string, partial: Partial<Moment> = {}): Moment {
  return {
    id, sessionId: "s1", windowId: "w", dayKey: "2026-09-22", at: "2026-09-22T06:00:00Z", decision: "keep", salience: 0.8,
    category: "complaint", trigger: "排队一个小时", why: "", myQuotes: ["排了好久的队"], sourceUtteranceIds: [],
    user: { copiedCount: 0 }, runId: "r", profileVersion: 1, createdAt: now, ...partial,
  };
}

describe("reflect 输出的代码校验", () => {
  const rules = [rule("seed-privacy", { locked: true, text: "私密丢" }), rule("user-1", { origin: "user", text: "我手写的规则" }), rule("seed-complaint", { text: "针对当下不方便的抱怨丢" })];
  const known = new Set(["m1", "m2"]);

  it("修改锁定条款的 op 被丢弃", () => {
    const r = validateReflectOps([{ op: "update", ruleId: "seed-privacy", kind: "drop", text: "感情话题可以留", evidenceMomentIds: ["m1"] }], rules, known);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toContain("锁定");
  });

  it("只凭 1 个例子改种子规则 → 拒绝（冒烟测试里真实发生过）", () => {
    const r = validateReflectOps([{ op: "update", ruleId: "seed-complaint", kind: "keep", text: "第一次体验若只描述场景没反思，不留。", evidenceMomentIds: ["m1"] }], rules, known);
    expect(r.rejected[0].reason).toContain("至少要 2 个");
  });

  it("用户手写的规则学习不改；停用也不行", () => {
    const r = validateReflectOps([{ op: "deactivate", ruleId: "user-1", kind: "keep", text: "", evidenceMomentIds: [] }], rules, known);
    expect(r.rejected[0].reason).toContain("用户");
  });

  it("没有证据、证据不在本次反馈里、超过 40 字、触碰底线说法、与已有规则重复 → 拒绝", () => {
    const r = validateReflectOps(
      [
        { op: "add", kind: "drop", text: "排队交通类抱怨你不留", evidenceMomentIds: ["zzz"] },
        { op: "add", kind: "style", text: "字".repeat(41), evidenceMomentIds: ["m1"] },
        { op: "add", kind: "style", text: "可以补充一些你没说过的细节", evidenceMomentIds: ["m1"] },
        { op: "add", kind: "drop", text: "针对当下不方便的抱怨丢", evidenceMomentIds: ["m1"] },
      ],
      rules,
      known,
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(4);
  });

  it("合法的新增和修改通过，应用后版本 +1、证据合并、原规则来源改为 learned", () => {
    const ops = [
      { op: "add" as const, kind: "drop" as const, text: "排队、交通这类抱怨，你不留。", evidenceMomentIds: ["m1", "m2"] },
      { op: "update" as const, ruleId: "seed-complaint", kind: "drop" as const, text: "排队和住宿的抱怨丢，上升到生活方式的留", evidenceMomentIds: ["m1", "m2"] },
    ];
    const r = validateReflectOps(ops, rules, known);
    expect(r.accepted).toHaveLength(2);
    const profile = applyReflectOps({ version: 3, rules, summary: "", createdAt: now }, r.accepted, { nowIso: now, runId: "run_reflect", summary: "学会了" });
    expect(profile.version).toBe(4);
    expect(profile.rules.find((x) => x.id === "seed-complaint")).toMatchObject({ origin: "learned", evidenceMomentIds: ["m1", "m2"] });
    expect(profile.rules.at(-1)).toMatchObject({ origin: "learned", evidenceMomentIds: ["m1", "m2"], active: true });
  });

  it("种子画像：隐私和忠实条款锁定", () => {
    const seed = seedProfile(now);
    expect(seed.version).toBe(1);
    expect(seed.rules.filter((r) => r.locked).map((r) => r.id)).toEqual(expect.arrayContaining(["seed-privacy", "seed-fidelity", "seed-no-sublimation"]));
  });
});

describe("反馈事件语义", () => {
  const base = moment("m1");
  it("删除 → user.decision=drop；捞回 → keep，并确认拿不准的说话人；复制计数；改写保存改后文字", () => {
    const at = now;
    expect(applyFeedback(base, { id: "e1", type: "delete", momentId: "m1", at }).decision).toBe("drop");
    expect(applyFeedback({ ...base, speakerUncertain: true }, { id: "e2", type: "restore", momentId: "m1", at })).toMatchObject({ decision: "keep", speakerConfirmed: true });
    expect(applyFeedback(base, { id: "e3", type: "copy", momentId: "m1", at, target: "quote" }).copiedCount).toBe(1);
    expect(applyFeedback(base, { id: "e4", type: "edit", momentId: "m1", at, before: "a", after: "b" }).editedText).toBe("b");
  });

  it("学到的例子：删除/捞回优先于复制，每类最多 2 条，共 ≤ 6 条", () => {
    const moments = new Map(["a", "b", "c", "d"].map((id, i) => [id, moment(id, { category: i < 3 ? "complaint" : "reflection" })]));
    const events: FeedbackEvent[] = [
      { id: "1", type: "copy", momentId: "d", at: "2026-09-22T10:00:00Z", target: "paragraph" },
      { id: "2", type: "delete", momentId: "a", at: "2026-09-22T09:00:00Z" },
      { id: "3", type: "delete", momentId: "b", at: "2026-09-22T09:10:00Z" },
      { id: "4", type: "delete", momentId: "c", at: "2026-09-22T09:20:00Z" },
    ];
    const examples = selectLearnedExamples(events, moments);
    expect(examples.map((e) => e.signal)).toEqual(["deleted", "deleted", "copied"]);
  });
});

describe("记忆索引与翻记忆", () => {
  const moments = [
    moment("m1", { dayKey: "2026-09-22", at: "2026-09-22T06:00:00Z", place: { name: "伦敦 · 海德公园", source: "gps" }, category: "reflection", trigger: "草坪上的人躺着晒太阳", why: "对休息的反思" }),
    moment("m2", { dayKey: "2026-09-22", at: "2026-09-22T07:00:00Z", place: { name: "伦敦 · 塔桥", source: "gps" }, trigger: "桥修了一百多年还在用", why: "复述的新知" }),
    moment("m3", { user: { decision: "drop", copiedCount: 0 }, trigger: "被删掉的" }),
    moment("m4", { decision: "drop", trigger: "问路" }),
  ];

  it("被删掉的、drop 的不进记忆；最近的在前", () => {
    const index = buildMemoryIndex(moments);
    expect(index.map((l) => l.split("|")[0])).toEqual(["m2", "m1"]);
  });

  it("「那片草坪」能翻到海德公园那段；日期精确过滤；没命中返回空", () => {
    const index = buildMemoryIndex(moments);
    expect(recallMemory(index, { query: "那片草坪" }).lines[0]).toContain("m1|2026-09-22|伦敦 · 海德公园");
    expect(recallMemory(index, { dayKey: "2026-09-23" }).lines).toEqual([]);
    expect(recallMemory(index, { query: "火锅" }).lines).toEqual([]);
  });
});
