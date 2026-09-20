import type { AudioSourceKind, SessionStatus, SpeakerRole, TraceStep } from "@/lib/memo/types";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  recording: "录音中",
  recorded: "待处理",
  uploading: "上传中",
  preparing: "转码中",
  transcribing: "转文字中",
  judging: "判断中",
  ready: "已完成",
  failed: "失败",
};

export const KIND_LABEL: Record<AudioSourceKind, string> = {
  in_app: "App 内录音",
  import: "导入的录音",
  backfill: "补一段",
};

export const SPEAKER_LABEL: Record<SpeakerRole, string> = {
  me: "我",
  other: "别人",
  uncertain: "拿不准",
};

export const DECISION_LABEL = { keep: "留", fold: "折叠", drop: "丢" } as const;

export const STEP_LABEL: Record<TraceStep["kind"], string> = {
  stage: "流程",
  model: "模型",
  tool: "工具",
  guard: "守卫",
  check: "检查",
  verify: "自查",
  retry: "重来",
  degrade: "降级",
  error: "失败",
};

export const ORIGIN_LABEL = { seed: "种子", learned: "学到的", user: "你写的" } as const;
export const RULE_KIND_LABEL = { keep: "该留", drop: "该丢", style: "文风" } as const;

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${String(s % 60).padStart(2, "0")} 秒` : `${s} 秒`;
}

export function formatYuan(yuan: number): string {
  if (yuan <= 0) return "¥0";
  return yuan < 0.01 ? `¥${yuan.toFixed(4)}` : `¥${yuan.toFixed(3)}`;
}
