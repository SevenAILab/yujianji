// 口令标记（外部设备接入工单 v2 Gate 1）：飞书拿不到录音豆的双击，用说出来的口令代替。
// 只认几种明确的说法；"留下"太常见（"留下来吃饭"），不当口令。
// 口令只是加分：窗口跳过粗筛直接判断、提示判断模型"用户主动标记了这里"；
// 不能绕过"必须是我说的"、隐私和忠实性守卫。口令本身不进原话。

const MARKER = /(记一下|记下来|帮我记(?:一下|住)?|小遇)/;
// 句首的口令连同后面的标点一起去掉："小遇，记一下：这里的风是咸的" → "这里的风是咸的"
const LEADING = /^(?:\s*(?:记一下|记下来|帮我记(?:一下|住)?|小遇)\s*[，,、。.:：!！~～]*\s*)+/;

export function hasMarker(text: string): boolean {
  return MARKER.test(text);
}

// 句尾的口令也去掉："这里的风是咸的，记一下。" → "这里的风是咸的"
const TRAILING = /(?:[，,、\s]*(?:记一下|记下来|帮我记(?:一下|住)?)\s*[。.!！~～]*\s*)+$/;

export function stripMarker(text: string): string {
  return text.replace(LEADING, "").replace(TRAILING, "").trim();
}

/** 窗口里"我"（或拿不准是不是我）说的话有没有口令 */
export function windowHasMarker(utterances: { speaker: string; text: string }[]): boolean {
  return utterances.some((u) => u.speaker !== "other" && hasMarker(u.text));
}
