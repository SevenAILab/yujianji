// 小遇的整理回执：手帐顶上一行"它做了什么"。只用本机已有的数据算，不调模型，也不写因果——
// "因为你删过两次"这种话算不出来就不说。
import type { DiaryDay, MemoSession, Moment } from "./types";

export interface DiaryReceipt {
  /** 当天录音总时长（分钟，不足 1 分钟记 0）；null = 这天没有录音，只有照片 */
  minutes: number | null;
  /** 写进手帐正文的段落 */
  kept: number;
  /** 放进折叠区的片段 */
  folded: number;
  /** 小遇判断不留的片段（不含你手动删掉的） */
  dropped: number;
  /** 整理时用的画像版本；> 1 说明用上了你教过的偏好 */
  profileVersion: number;
  generatedAt: string;
}

export function diaryReceipt(input: {
  diary: Pick<DiaryDay, "paragraphs" | "foldedMomentIds" | "profileVersion" | "generatedAt">;
  moments: Pick<Moment, "decision">[];
  sessions: Pick<MemoSession, "id" | "durationSec">[];
}): DiaryReceipt {
  const seen = new Set<string>();
  let seconds = 0;
  for (const session of input.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    seconds += Math.max(0, session.durationSec || 0);
  }
  return {
    minutes: seen.size ? Math.floor(seconds / 60) : null,
    kept: input.diary.paragraphs.length,
    folded: input.diary.foldedMomentIds.length,
    dropped: input.moments.filter((m) => m.decision === "drop").length,
    profileVersion: input.diary.profileVersion,
    generatedAt: input.diary.generatedAt,
  };
}

/** "小遇从 47 分钟录音里留下 3 段，折叠 5 段，丢掉 4 段。" 为 0 的部分不说。 */
export function receiptSentence(r: DiaryReceipt, agentName: string): string {
  const parts = [`留下 ${r.kept} 段`];
  if (r.folded) parts.push(`折叠 ${r.folded} 段`);
  if (r.dropped) parts.push(`丢掉 ${r.dropped} 段`);
  if (r.minutes === null) return `${agentName}把这天的照片按时间排好了。`;
  const source = r.minutes < 1 ? "不到 1 分钟的录音" : ` ${r.minutes} 分钟录音`;
  return `${agentName}从${source}里${parts.join("，")}。`;
}
