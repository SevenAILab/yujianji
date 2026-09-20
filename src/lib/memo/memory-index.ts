// 经历记忆索引：一行一条，先挑名单再展开，总量封顶（借鉴 Claude Code 记忆召回的做法，spec §4.5）。
import type { Moment } from "./types";
import { effectiveDecision } from "./select";

export const MEMORY_INDEX_MAX_LINES = 300;
export const RECALL_MAX_LINES = 10;
export const RECALL_MAX_CHARS = 1_500;

function clean(text: string | undefined, max: number): string {
  return (text ?? "").replace(/[|\r\n]+/g, " ").trim().slice(0, max);
}

/** momentId|dayKey|place|decision|trigger|why */
export function memoryLine(m: Pick<Moment, "id" | "dayKey" | "place" | "decision" | "user" | "trigger" | "why">): string {
  return [m.id, m.dayKey, clean(m.place?.name, 30) || "地点未知", effectiveDecision(m), clean(m.trigger, 30), clean(m.why, 30)].join("|");
}

/** 只放留下和折叠的；被用户删掉的、drop 的不进记忆。最近的优先。 */
export function buildMemoryIndex(moments: Moment[], opts: { excludeSessionId?: string } = {}): string[] {
  return moments
    .filter((m) => m.sessionId !== opts.excludeSessionId)
    .filter((m) => {
      const d = effectiveDecision(m);
      return d === "keep" || d === "fold";
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MEMORY_INDEX_MAX_LINES)
    .map(memoryLine);
}

export interface ParsedMemoryLine {
  momentId: string;
  dayKey: string;
  place: string;
  decision: string;
  trigger: string;
  why: string;
}

export function parseMemoryLine(line: string): ParsedMemoryLine | null {
  const [momentId, dayKey, place, decision, trigger = "", why = ""] = line.split("|");
  if (!momentId || !dayKey) return null;
  return { momentId, dayKey, place: place ?? "", decision: decision ?? "", trigger, why };
}

function grams(text: string): string[] {
  const out: string[] = [];
  for (const token of text.toLowerCase().split(/[\s,，。、;；:：|/]+/).filter(Boolean)) {
    if (/^[a-z0-9'-]+$/.test(token)) {
      out.push(token);
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) out.push(token);
    for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** recall_memory 的实现（纯函数）：日期精确过滤，地点和关键词按二字片段打分 */
export function recallMemory(
  index: string[],
  query: { query?: string; dayKey?: string; place?: string },
): { lines: string[]; matched: number; truncated: boolean } {
  const parsed = index.map((line) => ({ line, row: parseMemoryLine(line) })).filter((x) => x.row);
  let pool = parsed;
  if (query.dayKey) pool = pool.filter((x) => x.row!.dayKey === query.dayKey);

  const qGrams = grams([query.query, query.place].filter(Boolean).join(" "));
  let scored = pool.map((x) => {
    const hay = `${x.row!.place} ${x.row!.trigger} ${x.row!.why}`.toLowerCase();
    const score = qGrams.reduce((sum, g) => sum + (hay.includes(g) ? 1 : 0), 0);
    return { ...x, score };
  });
  if (qGrams.length) scored = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const x of scored) {
    if (lines.length >= RECALL_MAX_LINES || chars + x.line.length > RECALL_MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(x.line);
    chars += x.line.length;
  }
  return { lines, matched: scored.length, truncated };
}
