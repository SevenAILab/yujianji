// 按停顿切窗口：句间停顿 ≥ 8 秒，或累计 > 240 秒 / > 2500 字，就切一个窗口（spec §4.10）。
import type { MemoWindow, Utterance } from "./types";

export const WINDOW_PAUSE_MS = 8_000;
export const WINDOW_MAX_MS = 240_000;
export const WINDOW_MAX_CHARS = 2_500;
/** 粗筛：窗口里"我"（含拿不准）的字数少于它就不调模型 */
export const MIN_ME_CHARS = 15;

export function splitWindows(sessionId: string, utterances: Utterance[]): MemoWindow[] {
  const sorted = [...utterances].sort((a, b) => a.beginMs - b.beginMs || a.index - b.index);
  const windows: MemoWindow[] = [];
  let current: Utterance[] = [];
  let chars = 0;

  const flush = () => {
    if (!current.length) return;
    const index = windows.length;
    windows.push({
      id: `${sessionId}:w${index}`,
      sessionId,
      index,
      utteranceIds: current.map((u) => u.id),
      beginMs: current[0].beginMs,
      endMs: current[current.length - 1].endMs,
      meChars: current.filter((u) => u.speaker === "me").reduce((sum, u) => sum + u.text.length, 0),
      uncertainChars: current.filter((u) => u.speaker === "uncertain").reduce((sum, u) => sum + u.text.length, 0),
    });
    current = [];
    chars = 0;
  };

  for (const u of sorted) {
    if (current.length) {
      const last = current[current.length - 1];
      const pause = u.beginMs - last.endMs;
      const span = u.endMs - current[0].beginMs;
      if (pause >= WINDOW_PAUSE_MS || span > WINDOW_MAX_MS || chars + u.text.length > WINDOW_MAX_CHARS) flush();
    }
    current.push(u);
    chars += u.text.length;
  }
  flush();
  return windows;
}

export function shouldSkipWithoutModel(window: Pick<MemoWindow, "meChars" | "uncertainChars">): boolean {
  return window.meChars + window.uncertainChars < MIN_ME_CHARS;
}
