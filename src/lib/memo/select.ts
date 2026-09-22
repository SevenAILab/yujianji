// 当日选段（代码，spec §4.7）：keep 按 salience 取前 5 段，同一 15 分钟内最多 1 段（salience ≥ 0.8 除外）。
// v3：用户捞回的段落一定入选；用户删除的段落不入选、不进折叠区。
import type { Decision, Moment } from "./types";

export const DIARY_MAX_PARAGRAPHS = 5;
export const MIN_SALIENCE = 0.5;
export const SPACING_MS = 15 * 60_000;
export const SPACING_OVERRIDE_SALIENCE = 0.8;

type Selectable = Pick<Moment, "id" | "decision" | "salience" | "at" | "user" | "speakerUncertain">;

export function effectiveDecision(m: Pick<Moment, "decision" | "user">): Decision {
  if (m.user.decision === "drop") return "drop";
  if (m.user.decision === "keep") return "keep";
  return m.decision;
}

/**
 * 当天所有片段的时间跨度短于它，就不做间隔稀释——那本来就是一段集中的对话，
 * 按 15 分钟去稀释会把一段 3 分钟录音里的好内容全挤进折叠区。
 */
export const NO_SPACING_SPAN_MS = 30 * 60_000;

export function selectForDiary<T extends Selectable>(moments: T[]): { paragraphIds: string[]; foldedIds: string[] } {
  const time = (m: T) => new Date(m.at).getTime();
  const restored = moments.filter((m) => m.user.decision === "keep");
  const candidates = moments
    .filter((m) => m.user.decision === undefined && m.decision === "keep" && !m.speakerUncertain && m.salience >= MIN_SALIENCE)
    .sort((a, b) => b.salience - a.salience || time(a) - time(b));

  const stamps = moments.map(time).filter(Number.isFinite);
  const span = stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0;
  const spacing = span < NO_SPACING_SPAN_MS ? 0 : SPACING_MS;

  const selected: T[] = [...restored];
  for (const m of candidates) {
    if (selected.length >= Math.max(DIARY_MAX_PARAGRAPHS, restored.length)) break;
    const crowded = spacing > 0 && selected.some((s) => Math.abs(time(s) - time(m)) < spacing);
    if (crowded && m.salience < SPACING_OVERRIDE_SALIENCE) continue;
    selected.push(m);
  }

  const selectedIds = new Set(selected.map((m) => m.id));
  const folded = moments.filter((m) => {
    if (selectedIds.has(m.id)) return false;
    const effective = effectiveDecision(m);
    return effective === "keep" || effective === "fold";
  });

  return {
    paragraphIds: selected.sort((a, b) => time(a) - time(b)).map((m) => m.id),
    foldedIds: folded.sort((a, b) => time(a) - time(b)).map((m) => m.id),
  };
}

/** 写作用的原话：我的原话；用户确认过说话人时，拿不准的句子也算我的 */
export function quotesForWriting(m: Pick<Moment, "myQuotes" | "uncertainQuotes" | "user">): string[] {
  return m.user.speakerConfirmed ? [...m.myQuotes, ...(m.uncertainQuotes ?? [])] : m.myQuotes;
}


/**
 * 跨窗口的配图去重。G10 守卫只能管住单个窗口内的重复——一场录音会切成多个窗口、
 * 走多次 judge，每次守卫都拿到全新的"已占用"集合，所以同一张照片仍可能被两段拿到。
 * 这里按天做最终仲裁：salience 高的留住，其余留白（留白远好过两段配同一张图）。
 *
 * 返回 momentId → photoId，只包含真正该显示配图的片段。
 */
export function dedupePhotos<T extends Pick<Moment, "id" | "at" | "salience" | "photoId" | "decision">>(
  moments: T[],
): Map<string, string> {
  const taken = new Map<string, string>(); // photoId -> momentId
  const result = new Map<string, string>();
  const ordered = [...moments]
    .filter((m) => m.photoId && m.decision !== "drop")
    .sort((a, b) => b.salience - a.salience || new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const m of ordered) {
    const photoId = m.photoId!;
    if (taken.has(photoId)) continue; // 已经给了更重要的那段
    taken.set(photoId, m.id);
    result.set(m.id, photoId);
  }
  return result;
}
