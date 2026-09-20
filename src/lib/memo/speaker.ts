// 定"我"：手机在我身上，响度最大的通常是我。说话人三态：差距 < 3dB 时前两名都标 uncertain，只能折叠，等用户确认。
import type { SessionSpeaker, SpeakerRole } from "./types";

export const ME_GAP_DB = 3;

export interface SpeakerStat {
  key: string; // `${partIndex}:${speakerId}`
  meanDb: number | null;
  talkMs: number;
}

export interface SpeakerAssignment {
  speakers: SessionSpeaker[];
  meSource: "loudness" | "single_speaker" | "unavailable";
  meUncertain: boolean;
}

function partOf(key: string): string {
  return key.split(":")[0] ?? "0";
}

/**
 * 按分段分别判定：不同分段的 speakerId 不可比（spec §4.3），每段各自找"我"。
 * - 只有一位说话人 → me（single_speaker）
 * - 有人算不出响度（服务端降级）→ 该段全部 uncertain
 * - 最响与第二名差距 < 3dB → 与最响相差 3dB 以内的都 uncertain
 */
export function assignSpeakerRoles(stats: SpeakerStat[]): SpeakerAssignment {
  if (stats.length === 0) return { speakers: [], meSource: "unavailable", meUncertain: true };

  const byPart = new Map<string, SpeakerStat[]>();
  for (const stat of stats) {
    const list = byPart.get(partOf(stat.key)) ?? [];
    list.push(stat);
    byPart.set(partOf(stat.key), list);
  }

  const speakers: SessionSpeaker[] = [];
  let anyUncertain = false;
  let anyUnavailable = false;
  let allSingle = true;

  for (const list of byPart.values()) {
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
    const top = sorted[0].meanDb ?? 0;
    const gap = top - (sorted[1].meanDb ?? 0);
    for (const s of list) {
      let role: SpeakerRole;
      if (s.talkMs <= 0) role = "other";
      else if (gap < ME_GAP_DB) role = top - (s.meanDb ?? 0) < ME_GAP_DB ? "uncertain" : "other";
      else role = s === sorted[0] ? "me" : "other";
      if (role === "uncertain") anyUncertain = true;
      speakers.push({ ...s, role });
    }
  }

  return {
    speakers,
    meSource: anyUnavailable ? "unavailable" : allSingle ? "single_speaker" : "loudness",
    meUncertain: anyUncertain,
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
