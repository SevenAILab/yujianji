// 遇见手记数据模型。v3（2026-09-16）：说话人三态、时间区间与时区、地点来源与锁定、反馈事件联合类型、trace 结局与上限原因。
// 改动先在群里说；改字段要同步 spec §4.2。

export type AudioSourceKind = "in_app" | "import" | "backfill";

/** 说话人三态。uncertain = 响度判不开，只能折叠，用户确认后才算"我"。 */
export type SpeakerRole = "me" | "other" | "uncertain";

export type PlaceSource = "gps" | "photo" | "manual" | "backfill" | "session";
export type Confidence = "high" | "medium" | "low";

export interface PlaceRef {
  name: string;
  country?: string;
  lat?: number;
  lng?: number;
  source: PlaceSource;
  /** 按时间对到定位事件的远近推断；手动或确认后为 high。 */
  confidence?: Confidence;
  /** 用户确认或手改后锁定，重新判断不覆盖。 */
  locked?: boolean;
}

/** D1 采集时间轴。时间一律存 UTC ISO；显示与 dayKey 用会话时区换算。 */
export interface TimelineEvent {
  id: string;
  kind: "audio" | "location" | "photo";
  startAt: string;
  /** audio 是区间：录音结束时间；location / photo 为空。 */
  endAt?: string;
  /** audio → MemoSession.id；photo → Item.id；location 为空串 */
  refId: string;
  sessionId?: string;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  placeName?: string;
  source: "recorder" | "import" | "gps" | "manual" | "item";
}

export type SessionStatus =
  | "recording"
  | "recorded"
  | "uploading"
  | "preparing"
  | "transcribing"
  | "judging"
  | "ready"
  | "failed";

export type PipelineStage = "upload" | "prepare" | "transcribe" | "triage" | "judge" | "write";

export interface StageTiming {
  stage: PipelineStage;
  startedAt: string;
  ms?: number;
  /** 超出阶段预算时记下，过程页标黄 */
  overBudget?: boolean;
}

export interface SessionSpeaker {
  key: string; // `${partIndex}:${speakerId}`
  meanDb: number | null; // null = 服务端算不出响度（降级）
  talkMs: number;
  role: SpeakerRole;
}

export interface MemoSession {
  id: string;
  kind: AudioSourceKind;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  /** IANA 时区，采集或导入时取设备时区；dayKey 按它算 */
  timeZone: string;
  tzOffsetMin: number;
  /** recorder = App 内录音时钟；file_metadata = m4a mvhd（可能是文件创建时间，非精确开录时间）；user = 用户确认 */
  startedAtSource: "recorder" | "file_metadata" | "user";
  place?: PlaceRef;
  status: SessionStatus;
  error?: { step: PipelineStage | "record" | "import"; code: string; message: string; retryable: boolean };
  uploadId?: string;
  mime?: string;
  sizeBytes?: number;
  totalChunks?: number;
  confirmedChunks?: number;
  parts?: { partIndex: number; offsetMs: number; durationMs: number }[];
  asrTaskIds?: string[];
  speakers?: SessionSpeaker[];
  meSource?: "loudness" | "single_speaker" | "user" | "unavailable";
  meUncertain?: boolean;
  interruptions?: string[];
  timings?: StageTiming[];
  /** 补一段录音挂回的目标日（整场挂回时） */
  backfillDayKey?: string;
  createdAt: string;
  updatedAt: string;
}

/** App 内录音分块，合并上传后删除 */
export interface MemoChunk {
  sessionId: string;
  index: number;
  blob: Blob;
  createdAt: string;
}

/** 导入 / 合并后的待上传音频，上传成功（转写完成）后删除 */
export interface MemoAudio {
  sessionId: string;
  blob: Blob;
  mime: string;
  createdAt: string;
}

export interface Utterance {
  id: string; // `${sessionId}:${index}`
  sessionId: string;
  index: number;
  beginMs: number;
  endMs: number;
  speakerKey: string;
  speaker: SpeakerRole;
  text: string;
  expiresAt: string; // +7 天
}

export interface MemoWindow {
  id: string; // `${sessionId}:w${index}`
  sessionId: string;
  index: number;
  utteranceIds: string[];
  beginMs: number;
  endMs: number;
  meChars: number;
  /** 说话人拿不准的字数：粗筛时与 meChars 一起算，避免把可能是"我"的话直接跳过 */
  uncertainChars: number;
  triage?: { action: "judge" | "skip"; reason: string; runId: string };
  judge?: { status: "done" | "failed"; runId: string; error?: string };
  /** 本窗口判断后产出的本场笔记，传给下一个窗口 */
  sessionNotes?: string;
}

export type KeepCategory =
  | "difference"
  | "observation"
  | "memory"
  | "reflection"
  | "first_experience"
  | "retold_fact";
export type DropCategory =
  | "functional"
  | "complaint"
  | "others_only"
  | "guide"
  | "background"
  | "private"
  | "work_task";
export type MomentCategory = KeepCategory | DropCategory;
export type Decision = "keep" | "fold" | "drop";

export interface BackfillInfo {
  targetDayKey: string;
  targetPlace?: string;
  confidence: number;
  candidates?: { dayKey: string; place?: string; momentId?: string; label: string }[];
  confirmedByUser?: boolean;
}

export interface Moment {
  id: string;
  sessionId: string;
  windowId: string;
  dayKey: string;
  at: string;
  place?: PlaceRef;
  /** Agent + 代码守卫给出的决定。用户操作不改它，改 user.decision。 */
  decision: Decision;
  salience: number;
  category: MomentCategory;
  trigger: string;
  why: string;
  /** D8：代码按 sourceUtteranceIds 取 speaker=me 的原文，模型不产出。随 Moment 长期保存。 */
  myQuotes: string[];
  /** speaker=uncertain 的原文，只在折叠区标"可能是你说的"；7 天清理时一并清掉（除非用户确认） */
  uncertainQuotes?: string[];
  speakerUncertain?: boolean;
  sourceUtteranceIds: string[];
  othersParaphrase?: string;
  facts?: { entity: string; fact: string }[];
  linkedItemIds?: string[];
  backfill?: BackfillInfo;
  guardNotes?: string[];
  user: {
    /** delete → drop；restore → keep。有值时覆盖 decision */
    decision?: "keep" | "drop";
    copiedCount: number;
    editedText?: string;
    editedAt?: string;
    speakerConfirmed?: boolean;
  };
  runId: string;
  profileVersion: number;
  createdAt: string;
}

export interface DiaryParagraph {
  momentId: string;
  heading: string;
  text: string;
  verified: boolean;
  degraded: boolean;
  retries: number;
  /** 用户改过措辞：重新生成时保留，不重写 */
  userEdited?: boolean;
  issues?: string[];
}

export interface DiaryDay {
  dayKey: string;
  title: string;
  quotes: { momentId: string; text: string }[];
  paragraphs: DiaryParagraph[];
  foldedMomentIds: string[];
  profileVersion: number;
  generatedAt: string;
  runId: string;
  /** partial = 有会话或窗口失败，手记只含成功部分 */
  status: "ready" | "partial";
}

export interface ProfileRule {
  id: string;
  kind: "keep" | "drop" | "style";
  text: string;
  origin: "seed" | "learned" | "user";
  locked: boolean;
  evidenceMomentIds: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  version: number;
  rules: ProfileRule[];
  summary: string;
  createdAt: string;
  /** 生成这个版本的 reflect runId；种子版本为空 */
  runId?: string;
}

interface FeedbackBase {
  id: string;
  momentId: string;
  at: string;
  consumedByVersion?: number;
}

/** 反馈事件。影响范围见 spec §4.8「反馈语义表」。 */
export type FeedbackEvent =
  | (FeedbackBase & { type: "delete" })
  | (FeedbackBase & { type: "restore" })
  | (FeedbackBase & { type: "copy"; target: "paragraph" | "quote" })
  | (FeedbackBase & { type: "edit"; before: string; after: string });

export type FeedbackType = FeedbackEvent["type"];

export type TraceScope = "pipeline" | "triage" | "judge" | "write" | "reflect";

export interface TraceStep {
  kind: "stage" | "model" | "tool" | "guard" | "check" | "verify" | "retry" | "degrade" | "error";
  name: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  /** ≤ 200 字，经过脱敏；不含完整逐字稿、他人原话 */
  summary: string;
  /** 这一步为什么继续 / 为什么停 */
  reason?: string;
}

export interface AgentTrace {
  runId: string;
  scope: TraceScope;
  refId: string;
  sessionId?: string;
  dayKey?: string;
  startedAt: string;
  ms: number;
  costYuan: number;
  /** 费用里有估算价（输出价未核实）时为 true */
  costEstimated?: boolean;
  model?: string;
  outcome: "ok" | "degraded" | "failed";
  limitHit?: "steps" | "tool_calls" | "deadline";
  steps: TraceStep[];
}
