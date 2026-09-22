// 代码守卫：模型交卷后的硬规则。每次改判都作为事件返回，由调用方写进 trace（spec §4.6 + v3 说话人三态）。
import { DROP_CATEGORIES, type ModelMoment } from "./schema";
import type { Decision, MomentCategory, SpeakerRole } from "./types";
import { normalizeForMatch } from "./fillers";
import { isDayKey } from "./time";

export const TRIGGER_MAX = 30;
export const WHY_MAX = 30;
export const PARAPHRASE_MAX = 40;
export const BACKFILL_AUTO_CONFIDENCE = 0.6;
/** 转述里和他人原话连续相同的字数达到它，视为照抄原话 */
export const PARAPHRASE_VERBATIM_RUN = 12;

/**
 * 只有"说的就是眼前这个东西"的类别才配图。
 * reflection / memory / retold_fact 讲的是心里的事，不是眼前的物；
 * 同时段恰好拍了张照片，不代表那张照片就是这段话在讲的东西。
 * 实测踩过：用户拍了盆植物、口述的是别处的悬崖，模型把"要经历时间冲刷才能长成
 * 特别的样子"这句反思配到了那盆植物上——时间接近，内容无关。
 */
export const PHOTO_CATEGORIES = new Set<MomentCategory>(["observation", "first_experience", "difference"]);

export interface GuardUtterance {
  id: string;
  offsetMs: number;
  speaker: SpeakerRole;
  text: string;
}

export interface GuardEvent {
  code: "G1" | "G2" | "G2U" | "G3" | "G5" | "G8" | "G9" | "G10" | "LEN";
  kind: "guard" | "error";
  momentIndex: number;
  detail: string;
}

export interface GuardedMoment {
  sourceUtteranceIds: string[];
  decision: Decision;
  category: MomentCategory;
  salience: number;
  trigger: string;
  why: string;
  othersParaphrase?: string;
  facts?: { entity: string; fact: string }[];
  backfillTarget?: { dayKey: string; place?: string; confidence: number };
  /** G10 校验过的配图；不合法或抢不到就没有 */
  photoId?: string;
  myQuotes: string[];
  uncertainQuotes: string[];
  speakerUncertain: boolean;
  /** 补一段置信度不够（G5），前端让用户从候选里点 */
  needsPlacePick: boolean;
  guardNotes: string[];
}

const DROP_SET = new Set<string>(DROP_CATEGORIES);

function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length > max ? chars.slice(0, max).join("") : text.trim();
}

function longestCommonRun(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diagonal = saved;
    }
  }
  return best;
}

export function applyGuards(
  modelMoments: ModelMoment[],
  input: {
    mode: "session" | "backfill";
    utterances: GuardUtterance[];
    /** 本窗口允许配的照片 id（find_photos 的候选）。不传＝这一轮不允许配图 */
    photoCandidateIds?: string[];
  },
): { moments: GuardedMoment[]; events: GuardEvent[] } {
  // G10 配图：只能选候选里的；drop 不配图；一段最多一张（schema 已保证）；同一张图只给一段。
  // 按 salience 从高到低抢，先到先得——下面的循环本来就是这个顺序。
  const allowedPhotos = new Set(input.photoCandidateIds ?? []);
  const takenPhotos = new Set<string>();
  const byId = new Map(input.utterances.map((u) => [u.id, u]));
  const othersNormalized = input.utterances
    .filter((u) => u.speaker !== "me")
    .map((u) => normalizeForMatch(u.text));
  const covered = new Set<string>();
  const events: GuardEvent[] = [];
  const kept: { index: number; moment: GuardedMoment }[] = [];

  // 高 salience 先占位，重复片段保留更重要的那个
  const order = modelMoments.map((m, index) => ({ m, index })).sort((a, b) => b.m.salience - a.m.salience);

  for (const { m, index } of order) {
    const notes: string[] = [];
    const push = (code: GuardEvent["code"], detail: string, kind: GuardEvent["kind"] = "guard") => {
      events.push({ code, kind, momentIndex: index, detail });
      notes.push(code);
    };

    const ids = [...new Set(m.sourceUtteranceIds)];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) {
      events.push({ code: "G1", kind: "error", momentIndex: index, detail: `来源句子不在本窗口：${unknown.slice(0, 3).join(",")}，丢弃` });
      continue;
    }
    if (ids.every((id) => covered.has(id))) {
      events.push({ code: "G8", kind: "guard", momentIndex: index, detail: "与已保留的片段完全重复，丢弃" });
      continue;
    }

    const sources = ids.map((id) => byId.get(id)!).sort((a, b) => a.offsetMs - b.offsetMs);
    const mine = sources.filter((u) => u.speaker === "me");
    const uncertain = sources.filter((u) => u.speaker === "uncertain");

    let decision: Decision = m.decision;
    let category: MomentCategory = m.category;
    let speakerUncertain = false;

    if (decision !== "drop" && mine.length === 0 && uncertain.length === 0) {
      push("G2", `${decision} 的来源里没有"我"说的话 → drop / others_only`);
      decision = "drop";
      category = "others_only";
    }
    if (decision !== "drop" && mine.length === 0 && uncertain.length > 0) {
      speakerUncertain = true;
      if (decision === "keep") {
        push("G2U", "来源只有拿不准是谁说的句子 → fold，等用户确认");
        decision = "fold";
      } else {
        notes.push("G2U");
      }
    }
    if (decision === "keep" && DROP_SET.has(category)) {
      push("G3", `类别 ${category} 属于丢类，却判了 keep → fold`);
      decision = "fold";
    }

    const trigger = clip(m.trigger, TRIGGER_MAX);
    const why = clip(m.why, WHY_MAX);
    if (trigger !== m.trigger.trim() || why !== m.why.trim()) push("LEN", "trigger / why 超过 30 字，已截断");

    let othersParaphrase = m.othersParaphrase?.replace(/[“”"「」『』]/g, "").trim() || undefined;
    if (othersParaphrase && othersParaphrase !== m.othersParaphrase?.trim()) push("G9", "转述里带引号，已去掉引号");
    if (othersParaphrase) {
      const norm = normalizeForMatch(othersParaphrase);
      if (othersNormalized.some((other) => longestCommonRun(norm, other) >= PARAPHRASE_VERBATIM_RUN)) {
        push("G9", "转述与他人原话连续相同过多，视为照抄，已移除");
        othersParaphrase = undefined;
      } else if ([...othersParaphrase].length > PARAPHRASE_MAX) {
        othersParaphrase = clip(othersParaphrase, PARAPHRASE_MAX);
        push("LEN", "转述超过 40 字，已截断");
      }
    }

    let needsPlacePick = false;
    let backfillTarget = m.backfillTarget;
    if (input.mode === "backfill" && decision !== "drop") {
      if (!backfillTarget || !isDayKey(backfillTarget.dayKey)) {
        push("G5", "补一段没有给出有效的目标日期 → 让用户选");
        backfillTarget = undefined;
        needsPlacePick = true;
      } else if (backfillTarget.confidence < BACKFILL_AUTO_CONFIDENCE) {
        push("G5", `挂回置信度 ${backfillTarget.confidence.toFixed(2)} < 0.6 → 不自动挂回，让用户选`);
        needsPlacePick = true;
      }
    }

    const isDrop = decision === "drop";
    // G10：配图校验
    let photoId: string | undefined;
    if (m.photoId) {
      if (isDrop) push("G10", `drop 的片段不配图 → 丢掉 ${m.photoId}`);
      else if (!PHOTO_CATEGORIES.has(category)) push("G10", `${category} 讲的不是眼前的东西 → 不配图`);
      else if (!allowedPhotos.has(m.photoId)) push("G10", `${m.photoId} 不在候选里 → 丢掉`);
      else if (takenPhotos.has(m.photoId)) push("G10", `${m.photoId} 已经被更重要的片段用了 → 这段留白`);
      else {
        photoId = m.photoId;
        takenPhotos.add(m.photoId);
      }
    }

    for (const id of ids) covered.add(id);
    kept.push({ index, moment: {
      sourceUtteranceIds: sources.map((u) => u.id),
      decision,
      category,
      salience: Math.min(1, Math.max(0, m.salience)),
      trigger,
      why,
      othersParaphrase: isDrop ? undefined : othersParaphrase,
      facts: isDrop ? undefined : m.facts,
      backfillTarget: isDrop ? undefined : backfillTarget,
      photoId,
      // G4（D8）：原话由代码按 id 取，模型不产出。drop 的片段不长期保存原话（隐私：只在 7 天内的逐字稿里可见）
      myQuotes: isDrop ? [] : mine.map((u) => u.text),
      uncertainQuotes: isDrop ? [] : uncertain.map((u) => u.text),
      speakerUncertain,
      needsPlacePick,
      guardNotes: notes,
    } });
  }

  // 恢复成模型原来的顺序，方便对照 trace
  kept.sort((a, b) => a.index - b.index);
  return { moments: kept.map((k) => k.moment), events };
}
