// 定"我"：优先用"录音开头是谁在说"（按下录音的人先开口）；没有这个信号时退回响度。
// 响度差距 < 3dB 时仍然认最响的那个是我，但整体标 meUncertain——宁可给一个可一键纠正的答案，
// 也不要像以前那样全员 uncertain，那会让所有 keep 被 G2U 降成 fold，最后写不出手记。
import type { SessionSpeaker, SpeakerRole } from "./types";

export const ME_GAP_DB = 3;
/** 录音开头这段时间里说得最多的人＝我。用户按下录音键后通常先开口。 */
export const OPENING_WINDOW_MS = 10_000;

export interface SpeakerStat {
  key: string; // `${partIndex}:${speakerId}`
  meanDb: number | null;
  talkMs: number;
}

export interface SpeakerAssignment {
  speakers: SessionSpeaker[];
  meSource: "enrolled" | "opening" | "loudness" | "loudness_weak" | "single_speaker" | "unavailable";
  meUncertain: boolean;
}

/**
 * 录音开头 windowMs 内说话时长最多的 speakerKey。
 * 导入的录音（语音备忘录）没有"先自报家门"这个前提，调用方不要传。
 */
export function openingSpeakerKey(
  sentences: { beginMs: number; endMs: number; speakerKey: string }[],
  windowMs = OPENING_WINDOW_MS,
): string | null {
  const talk = new Map<string, number>();
  for (const s of sentences) {
    if (s.beginMs >= windowMs) continue;
    const ms = Math.min(s.endMs, windowMs) - s.beginMs;
    if (ms > 0) talk.set(s.speakerKey, (talk.get(s.speakerKey) ?? 0) + ms);
  }
  let best: string | null = null;
  let bestMs = 0;
  for (const [key, ms] of talk) if (ms > bestMs) { best = key; bestMs = ms; }
  return best;
}

function partOf(key: string): string {
  return key.split(":")[0] ?? "0";
}

/**
 * 按分段分别判定：不同分段的 speakerId 不可比（spec §4.3），每段各自找"我"。
 * - 传了 meKey（开头自报家门 / 声纹注册命中）→ 它就是我，不留 uncertain
 * - 只有一位说话人 → me（single_speaker）
 * - 有人算不出响度（服务端降级）→ 该段全部 uncertain
 * - 最响与第二名差距 ≥ 3dB → 最响的是我（loudness）
 * - 差距 < 3dB → 仍认最响的是我，但 meSource=loudness_weak 且 meUncertain=true，UI 要提示可一键纠正
 */
export function assignSpeakerRoles(
  stats: SpeakerStat[],
  opts: {
    /** 每个分段各自的"我"（声纹注册命中 / 开头自报家门）。分段之间的 speakerId 不可比，所以是一组不是一个 */
    meKeys?: readonly string[] | null;
    /** 这些 key 是怎么来的，只影响 meSource 的取值 */
    meKeySource?: "enrolled" | "opening";
  } = {},
): SpeakerAssignment {
  if (stats.length === 0) return { speakers: [], meSource: "unavailable", meUncertain: true };

  const known = new Set((opts.meKeys ?? []).filter((key) => stats.some((s) => s.key === key)));

  const byPart = new Map<string, SpeakerStat[]>();
  for (const stat of stats) {
    const list = byPart.get(partOf(stat.key)) ?? [];
    list.push(stat);
    byPart.set(partOf(stat.key), list);
  }

  const speakers: SessionSpeaker[] = [];
  let anyUncertain = false;
  let anyUnavailable = false;
  let anyWeak = false;
  let allSingle = true;

  let anyKnown = false;
  for (const list of byPart.values()) {
    // 这一段有明确的"我"就直接用，不看响度
    const hit = list.find((s) => known.has(s.key));
    if (hit) {
      anyKnown = true;
      allSingle = false;
      for (const s of list) speakers.push({ ...s, role: s.key === hit.key ? "me" : "other" });
      continue;
    }
    const talking = list.filter((s) => s.talkMs > 0);
    if (talking.length <= 1) {
      for (const s of list) speakers.push({ ...s, role: s === talking[0] ? "me" : "other" });
      continue;
    }
    allSingle = false;
    if (talking.some((s) => s.meanDb === null)) {
      anyUnavailable = true;
      anyUncertain = true;
      for (const s of list) speakers.push({ ...s, role: "uncertain" });
      continue;
    }
    const sorted = [...talking].sort((a, b) => (b.meanDb ?? 0) - (a.meanDb ?? 0));
    const gap = (sorted[0].meanDb ?? 0) - (sorted[1].meanDb ?? 0);
    // 差距小的时候也要给出"我"，否则 G2U 会把所有 keep 降成 fold，手记就空了。
    if (gap < ME_GAP_DB) anyWeak = true;
    for (const s of list) {
      const role: SpeakerRole = s.talkMs > 0 && s === sorted[0] ? "me" : "other";
      speakers.push({ ...s, role });
    }
  }

  return {
    speakers,
    meSource: anyUnavailable
      ? "unavailable"
      : allSingle
        ? "single_speaker"
        : anyWeak
          ? "loudness_weak"
          : anyKnown
            ? (opts.meKeySource ?? "opening")
            : "loudness",
    meUncertain: anyUncertain || anyWeak,
  };
}

/** 用户一键纠正：点选的 key 是我，其余都是别人。之后不再有 uncertain。 */
export function applySpeakerCorrection(speakers: SessionSpeaker[], meKeys: string[]): SessionSpeaker[] {
  const me = new Set(meKeys);
  return speakers.map((s) => ({ ...s, role: me.has(s.key) ? "me" : "other" }));
}

export function roleOf(speakers: SessionSpeaker[] | undefined, key: string): SpeakerRole {
  return speakers?.find((s) => s.key === key)?.role ?? "uncertain";
}
