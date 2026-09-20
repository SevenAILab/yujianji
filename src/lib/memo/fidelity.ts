// 写作的确定性检查（spec §4.7 第 2 步）。不依赖模型，任何一条不过都会带着原因退回重写。
import { normalizeForMatch } from "./fillers";

export const PARAGRAPH_MAX_CHARS = 180;
export const PARAGRAPH_MIN_CHARS = 30;

/** 升华黑名单：原话里没有时出现就拦。可扩充。 */
export const SUBLIMATION_BLACKLIST = [
  "我终于明白",
  "终于明白",
  "我明白了",
  "这就是生活",
  "意义在于",
  "或许这就是",
  "也许这就是",
  "让我懂得",
  "让我明白",
  "人生",
  "生活的真谛",
  "岁月静好",
  "治愈",
  "灵魂",
  "心灵",
];

export interface FidelityIssue {
  code: "LENGTH" | "SUBLIMATION" | "QUOTED_OTHERS" | "UNGROUNDED_NUMBER" | "UNGROUNDED_LATIN";
  detail: string;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** "三百" → 300，"十五" → 15，"两千零八" → 2008，"一万二" 这类口语省略不处理 */
export function cnNumeralToNumber(text: string): number | null {
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      section += (digit || 1) * CN_UNITS[ch];
      digit = 0;
    } else if (ch === "万") {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(/\d+(?:\.\d+)?/g) ?? []) out.add(String(Number(m)));
  for (const m of text.match(/[零〇一二两三四五六七八九十百千万]{1,8}/g) ?? []) {
    const n = cnNumeralToNumber(m);
    if (n !== null) out.add(String(n));
    // 逐字也放进去："九九六" 这种读法
    if (/^[零〇一二两三四五六七八九]+$/.test(m)) out.add(String(Number([...m].map((c) => CN_DIGITS[c]).join(""))));
  }
  return out;
}

export function visibleLength(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}

export function checkParagraph(text: string, source: { myQuotes: string[]; othersParaphrase?: string }): FidelityIssue[] {
  const issues: FidelityIssue[] = [];
  const sourceText = [...source.myQuotes, source.othersParaphrase ?? ""].join("\n");
  const sourceLower = sourceText.toLowerCase();

  const length = visibleLength(text);
  // 原话本身很短时下限跟着降，不能逼模型为了凑字数加戏
  const minChars = Math.min(PARAGRAPH_MIN_CHARS, Math.max(8, normalizeForMatch(source.myQuotes.join("")).length));
  if (length < minChars || length > PARAGRAPH_MAX_CHARS) {
    issues.push({ code: "LENGTH", detail: `长度 ${length} 字，应在 ${minChars}–${PARAGRAPH_MAX_CHARS} 字之间` });
  }

  for (const phrase of SUBLIMATION_BLACKLIST) {
    if (text.includes(phrase) && !sourceText.includes(phrase)) {
      issues.push({ code: "SUBLIMATION", detail: `出现了原话里没有的升华说法「${phrase}」` });
    }
  }

  const mineNormalized = normalizeForMatch(source.myQuotes.join(""));
  for (const m of text.matchAll(/[“"「『]([^”"」』]{2,})[”"」』]/g)) {
    const inner = normalizeForMatch(m[1]);
    if (inner && !mineNormalized.includes(inner)) {
      issues.push({ code: "QUOTED_OTHERS", detail: `引号里的「${m[1].slice(0, 20)}」不是你的原话` });
    }
  }

  const sourceNumbers = numbersIn(sourceText);
  for (const m of new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])) {
    if (!sourceNumbers.has(String(Number(m)))) {
      issues.push({ code: "UNGROUNDED_NUMBER", detail: `数字「${m}」在原话里找不到` });
    }
  }

  for (const word of new Set(text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [])) {
    if (word.length >= 2 && !sourceLower.includes(word.toLowerCase())) {
      issues.push({ code: "UNGROUNDED_LATIN", detail: `英文「${word}」在原话里找不到` });
    }
  }

  return issues;
}
