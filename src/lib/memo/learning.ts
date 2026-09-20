// 学习（spec §4.8）：种子画像、学到的例子、reflect 输出的代码校验与应用。写权限由代码限制，不靠提示词自觉。
import { nanoid } from "nanoid";
import type { ReflectOp } from "./schema";
import type { FeedbackEvent, Moment, MomentCategory, Profile, ProfileRule } from "./types";

export const REFLECT_MIN_EVENTS = 3;
export const RULE_MAX_CHARS = 40;
/** 改动或停用种子规则至少要 2 个片段作证据：冒烟测试里模型拿 1 个例子就改写了"第一次的体验，留" */
export const SEED_CHANGE_MIN_EVIDENCE = 2;
export const LEARNED_EXAMPLE_LIMIT = 6;

type SeedRule = Pick<ProfileRule, "id" | "kind" | "text" | "locked">;

/** 种子规则来自方案 §3、§4；隐私和忠实条款 locked，学习不可改 */
export const SEED_RULES: SeedRule[] = [
  { id: "seed-premise", kind: "keep", text: "只留你自己说出口的；别人说得再精彩，你没说出想法就不留。", locked: true },
  { id: "seed-difference", kind: "keep", text: "看到的差异和新鲜：文化、生活方式、习惯，留。", locked: false },
  { id: "seed-observation", kind: "keep", text: "带着感受的观察，留。", locked: false },
  { id: "seed-memory", kind: "keep", text: "看到东西想起过去，留。", locked: false },
  { id: "seed-reflection", kind: "keep", text: "反思、对自己的冲击、想做的改变，留。", locked: false },
  { id: "seed-first", kind: "keep", text: "第一次的体验和评价，留。", locked: false },
  { id: "seed-retold", kind: "keep", text: "你复述出来、打动了你的新知，留；讲解员原话丢。", locked: false },
  { id: "seed-functional", kind: "drop", text: "功能性事务：问路、点单、买票、砍价、入住，丢。", locked: false },
  { id: "seed-complaint", kind: "drop", text: "针对当下不方便的抱怨丢；上升到文化或生活方式的留。", locked: false },
  { id: "seed-background", kind: "drop", text: "电话、背景人声、广播、音乐，丢。", locked: false },
  { id: "seed-work", kind: "drop", text: "事务性的工作讨论丢；新场合里对人和事的感受留。", locked: false },
  { id: "seed-privacy", kind: "drop", text: "私密：具体的感情关系、身体、收入，丢。", locked: true },
  { id: "seed-others", kind: "style", text: "同伴的话只以转述加署名出现，不引用别人的原话。", locked: true },
  { id: "seed-fidelity", kind: "style", text: "不加你没说过的观点、情绪、结论、事实、细节。", locked: true },
  { id: "seed-no-sublimation", kind: "style", text: "「我终于明白……」这类升华句永远不加。", locked: true },
  { id: "seed-voice", kind: "style", text: "第一人称，精炼有文笔，每段 2–4 句。", locked: false },
  { id: "seed-keywords", kind: "style", text: "保留你的关键词和比喻，比如 chill、卷、996。", locked: false },
];

export function seedProfile(nowIso: string): Profile {
  return {
    version: 1,
    rules: SEED_RULES.map((rule) => ({
      ...rule,
      origin: "seed",
      evidenceMomentIds: [],
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    })),
    summary: "种子画像：来自产品方案里的判断标准和文风规则。",
    createdAt: nowIso,
  };
}

export function activeRules(profile: Profile, kinds?: ProfileRule["kind"][]): ProfileRule[] {
  return profile.rules.filter((r) => r.active && (!kinds || kinds.includes(r.kind)));
}

export interface LearnedExample {
  signal: "deleted" | "restored" | "copied";
  category: MomentCategory;
  trigger: string;
  why: string;
  quote: string;
}

const SIGNAL_OF: Partial<Record<FeedbackEvent["type"], LearnedExample["signal"]>> = {
  delete: "deleted",
  restore: "restored",
  copy: "copied",
};
const SIGNAL_RANK: Record<LearnedExample["signal"], number> = { restored: 0, deleted: 0, copied: 1 };

/** 删除、捞回、复制过的片段摘要：删除/捞回优先，同 category 优先，时间近优先，每类最多 2 条，共 ≤ 6 条 */
export function selectLearnedExamples(
  events: FeedbackEvent[],
  momentsById: Map<string, Moment>,
  preferCategories: MomentCategory[] = [],
  limit = LEARNED_EXAMPLE_LIMIT,
): LearnedExample[] {
  const latestByMoment = new Map<string, FeedbackEvent>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (SIGNAL_OF[e.type]) latestByMoment.set(e.momentId, e);
  }
  const prefer = new Set(preferCategories);
  const rows = [...latestByMoment.values()]
    .map((e) => ({ e, m: momentsById.get(e.momentId) }))
    .filter((x): x is { e: FeedbackEvent; m: Moment } => Boolean(x.m))
    .sort(
      (a, b) =>
        SIGNAL_RANK[SIGNAL_OF[a.e.type]!] - SIGNAL_RANK[SIGNAL_OF[b.e.type]!] ||
        Number(prefer.has(b.m.category)) - Number(prefer.has(a.m.category)) ||
        b.e.at.localeCompare(a.e.at),
    );

  const perCategory = new Map<string, number>();
  const out: LearnedExample[] = [];
  for (const { e, m } of rows) {
    if (out.length >= limit) break;
    const count = perCategory.get(m.category) ?? 0;
    if (count >= 2) continue;
    perCategory.set(m.category, count + 1);
    out.push({
      signal: SIGNAL_OF[e.type]!,
      category: m.category,
      trigger: m.trigger,
      why: m.why,
      quote: (m.myQuotes[0] ?? m.uncertainQuotes?.[0] ?? "").slice(0, 60),
    });
  }
  return out;
}

/** 触碰锁定条款的说法：学习永远学不走"可以编"和"可以留别人的隐私" */
const FORBIDDEN_RULE_PATTERNS = [
  /可以(编|加|补|虚构|想象|发挥|升华)/,
  /(补充|加上).{0,6}没说/,
  /(保留|引用|留下).{0,6}(别人|同伴|朋友|他人).{0,4}原话/,
  /(隐私|私密|感情|收入|身体).{0,8}(也)?(可以)?留/,
];

function normalizeRule(text: string): string {
  return text.replace(/[\s\p{P}]/gu, "");
}

export interface OpRejection {
  op: ReflectOp;
  reason: string;
}

export function validateReflectOps(
  ops: ReflectOp[],
  rules: ProfileRule[],
  knownMomentIds: Set<string>,
): { accepted: ReflectOp[]; rejected: OpRejection[] } {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const accepted: ReflectOp[] = [];
  const rejected: OpRejection[] = [];
  const touched = new Set<string>();

  for (const raw of ops) {
    const op = { ...raw, text: raw.text.trim(), evidenceMomentIds: raw.evidenceMomentIds.filter((id) => knownMomentIds.has(id)) };
    const reject = (reason: string) => rejected.push({ op: raw, reason });

    if (op.op !== "deactivate" && op.evidenceMomentIds.length === 0) {
      reject("没有引用本次反馈里的片段作证据");
      continue;
    }
    if (op.op !== "deactivate" && (!op.text || [...op.text].length > RULE_MAX_CHARS)) {
      reject(`规则为空或超过 ${RULE_MAX_CHARS} 字`);
      continue;
    }
    if (op.op !== "deactivate" && FORBIDDEN_RULE_PATTERNS.some((p) => p.test(op.text))) {
      reject("触碰隐私或忠实底线（锁定条款），代码拒绝");
      continue;
    }

    if (op.op === "add") {
      const norm = normalizeRule(op.text);
      const duplicate = rules.find((r) => r.active && (normalizeRule(r.text) === norm || normalizeRule(r.text).includes(norm) || norm.includes(normalizeRule(r.text))));
      if (duplicate) {
        reject(`与已有规则「${duplicate.text.slice(0, 16)}」重复，应修改已有规则`);
        continue;
      }
      accepted.push(op);
      continue;
    }

    const target = op.ruleId ? byId.get(op.ruleId) : undefined;
    if (!target) {
      reject("要修改的规则不存在");
      continue;
    }
    if (target.locked) {
      reject("锁定条款不可被学习修改");
      continue;
    }
    if (target.origin === "user") {
      reject("用户亲手写的规则优先级最高，学习不改");
      continue;
    }
    if (target.origin === "seed" && new Set(op.evidenceMomentIds).size < SEED_CHANGE_MIN_EVIDENCE) {
      reject(`改动种子规则至少要 ${SEED_CHANGE_MIN_EVIDENCE} 个片段作证据`);
      continue;
    }
    if (touched.has(target.id)) {
      reject("同一条规则一次只改一次");
      continue;
    }
    touched.add(target.id);
    accepted.push(op);
  }
  return { accepted, rejected };
}

export function applyReflectOps(profile: Profile, ops: ReflectOp[], meta: { nowIso: string; runId: string; summary: string }): Profile {
  const rules = profile.rules.map((r) => ({ ...r, evidenceMomentIds: [...r.evidenceMomentIds] }));
  for (const op of ops) {
    if (op.op === "add") {
      rules.push({
        id: `rule_${nanoid(10)}`,
        kind: op.kind,
        text: op.text,
        origin: "learned",
        locked: false,
        evidenceMomentIds: op.evidenceMomentIds,
        active: true,
        createdAt: meta.nowIso,
        updatedAt: meta.nowIso,
      });
      continue;
    }
    const target = rules.find((r) => r.id === op.ruleId);
    if (!target) continue;
    if (op.op === "deactivate") {
      target.active = false;
    } else {
      target.text = op.text;
      target.kind = op.kind;
      target.origin = "learned";
    }
    target.evidenceMomentIds = [...new Set([...target.evidenceMomentIds, ...op.evidenceMomentIds])];
    target.updatedAt = meta.nowIso;
  }
  return { version: profile.version + 1, rules, summary: meta.summary, createdAt: meta.nowIso, runId: meta.runId };
}
