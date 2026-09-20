// 口水词表：降级文本（整理后的原话）和今日金句校验共用同一张表，保证两边口径一致。

export const FILLER_WORDS = [
  "对对对",
  "就是说",
  "嗯嗯",
  "然后",
  "那个",
  "嗯",
  "呃",
  "额",
  "啊",
] as const;

const FILLER_PATTERN = new RegExp(
  [...FILLER_WORDS].sort((a, b) => b.length - a.length).join("|"),
  "g",
);

const SENTENCE_END = /[。！？!?…]$/;

/** 去口水词，并收拾因此多出来的标点和空白 */
export function stripFillers(text: string): string {
  return text
    .replace(FILLER_PATTERN, "")
    .replace(/\s+([，。！？、,.!?])/g, "$1")
    .replace(/([，、,])\s*(?=[，。！？、,.!?])/g, "")
    .replace(/^[\s，。！？、,.!?]+/, "")
    .replace(/[\s，、,;；]+$/, "")
    .replace(/[，、,]{2,}/g, "，")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 比较用：去口水词后再去掉所有标点和空白、统一大小写 */
export function normalizeForMatch(text: string): string {
  return stripFillers(text)
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

/** 降级文本：代码生成的"整理后的原话"，去口水词后用句号连接，不增删一个实词 */
export function degradeFromQuotes(quotes: string[]): string {
  return quotes
    .map(stripFillers)
    .filter((q) => q.replace(/[\s\p{P}]/gu, "").length > 0)
    .map((q) => (SENTENCE_END.test(q) ? q : `${q.replace(/[，、,;；]+$/, "")}。`))
    .join("");
}
