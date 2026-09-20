// 今日金句校验（spec §4.7 第 5 步）：必须是"我"的原话，去口水词后逐字能找到；显示的文字直接从原话里截，不用模型给的版本。
import { stripFillers } from "./fillers";

export const QUOTE_MIN_CHARS = 8;
export const QUOTE_MAX_CHARS = 40;
export const QUOTE_MAX_COUNT = 3;

export interface QuoteSource {
  momentId: string;
  myQuotes: string[];
  salience: number;
}

export interface QuoteRejection {
  momentId: string;
  text: string;
  reason: "UNKNOWN_MOMENT" | "NOT_VERBATIM" | "LENGTH" | "DUP_MOMENT" | "OVER_LIMIT";
}

const IGNORABLE = /[\s\p{P}\p{S}]/u;

function indexed(text: string): { norm: string; map: number[]; chars: string[] } {
  const chars = [...stripFillers(text)];
  let norm = "";
  const map: number[] = [];
  chars.forEach((ch, index) => {
    if (IGNORABLE.test(ch)) return;
    const lower = ch.toLowerCase();
    norm += lower.length === ch.length ? lower : ch;
    map.push(index);
  });
  return { norm, map, chars };
}

function tidy(text: string): string {
  return text.replace(/^[\s，。、；,.;：:]+/, "").replace(/[\s，。、；,.;：:]+$/, "").trim();
}

/** 在原话里找到 candidate 的逐字位置，返回原话里那一段（保留原话自己的标点）；找不到返回 null */
export function locateVerbatim(candidate: string, myQuotes: string[]): string | null {
  const q = indexed(candidate).norm;
  if (!q) return null;
  const src = indexed(myQuotes.join("。"));
  const at = src.norm.indexOf(q);
  if (at < 0) return null;
  const start = src.map[at];
  const end = src.map[at + q.length - 1];
  return tidy(src.chars.slice(start, end + 1).join(""));
}

export function quoteLength(text: string): number {
  return [...text.replace(/[\s\p{P}]/gu, "")].length;
}

export function verifyQuotes(
  candidates: { momentId: string; text: string }[],
  sources: QuoteSource[],
): { quotes: { momentId: string; text: string }[]; rejected: QuoteRejection[]; fallbackUsed: boolean } {
  const byId = new Map(sources.map((s) => [s.momentId, s]));
  const quotes: { momentId: string; text: string }[] = [];
  const rejected: QuoteRejection[] = [];
  const usedMoments = new Set<string>();

  for (const candidate of candidates) {
    const source = byId.get(candidate.momentId);
    if (!source) {
      rejected.push({ ...candidate, reason: "UNKNOWN_MOMENT" });
      continue;
    }
    const verbatim = locateVerbatim(candidate.text, source.myQuotes);
    if (!verbatim) {
      rejected.push({ ...candidate, reason: "NOT_VERBATIM" });
      continue;
    }
    const length = quoteLength(verbatim);
    if (length < QUOTE_MIN_CHARS || length > QUOTE_MAX_CHARS) {
      rejected.push({ ...candidate, reason: "LENGTH" });
      continue;
    }
    if (usedMoments.has(candidate.momentId)) {
      rejected.push({ ...candidate, reason: "DUP_MOMENT" });
      continue;
    }
    if (quotes.length >= QUOTE_MAX_COUNT) {
      rejected.push({ ...candidate, reason: "OVER_LIMIT" });
      continue;
    }
    usedMoments.add(candidate.momentId);
    quotes.push({ momentId: candidate.momentId, text: verbatim });
  }

  if (quotes.length > 0 || sources.length === 0) return { quotes, rejected, fallbackUsed: false };

  // 兜底：salience 最高的片段里，第一句 8–40 字的原句（去口水词）
  const best = [...sources].sort((a, b) => b.salience - a.salience);
  for (const source of best) {
    for (const quote of source.myQuotes) {
      for (const sentence of stripFillers(quote).split(/(?<=[。！？!?])/)) {
        const text = tidy(sentence);
        const length = quoteLength(text);
        if (length >= QUOTE_MIN_CHARS && length <= QUOTE_MAX_CHARS) {
          return { quotes: [{ momentId: source.momentId, text }], rejected, fallbackUsed: true };
        }
      }
    }
  }
  return { quotes, rejected, fallbackUsed: true };
}
