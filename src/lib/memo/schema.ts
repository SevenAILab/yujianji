// 遇见手记接口与模型输出的 Zod 契约（服务端校验、Agent 交卷、eval 共用）。
import { z } from "zod";

export const KEEP_CATEGORIES = [
  "difference",
  "observation",
  "memory",
  "reflection",
  "first_experience",
  "retold_fact",
] as const;
export const DROP_CATEGORIES = [
  "functional",
  "complaint",
  "others_only",
  "guide",
  "background",
  "private",
  "work_task",
] as const;

export const CATEGORY_LABELS: Record<(typeof KEEP_CATEGORIES)[number] | (typeof DROP_CATEGORIES)[number], string> = {
  difference: "差异和新鲜",
  observation: "带感受的观察",
  memory: "想起过去",
  reflection: "反思",
  first_experience: "第一次的体验",
  retold_fact: "复述的新知",
  functional: "功能性事务",
  complaint: "抱怨",
  others_only: "别人说的",
  guide: "讲解原话",
  background: "背景声",
  private: "私密",
  work_task: "事务性工作",
};

export const categorySchema = z.enum([...KEEP_CATEGORIES, ...DROP_CATEGORIES]);
export const decisionSchema = z.enum(["keep", "fold", "drop"]);
export const speakerRoleSchema = z.enum(["me", "other", "uncertain"]);
const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().min(1).max(160);
export const runIdSchema = z.string().regex(/^[A-Za-z0-9_:.-]{6,120}$/);

// ── 判断 ─────────────────────────────────────────────────────────────

export const windowUtteranceSchema = z.object({
  id: idSchema,
  offsetMs: z.number().int().min(0),
  speaker: speakerRoleSchema,
  text: z.string().max(2_500),
});

export const judgeWindowSchema = z.object({
  id: idSchema,
  utterances: z.array(windowUtteranceSchema).min(1).max(400),
});

export const profileRuleInputSchema = z.object({
  id: idSchema,
  kind: z.enum(["keep", "drop", "style"]),
  text: z.string().min(1).max(80),
  origin: z.enum(["seed", "learned", "user"]),
  locked: z.boolean(),
});

export const profileInputSchema = z.object({
  version: z.number().int().min(1),
  rules: z.array(profileRuleInputSchema).max(80),
});

export const learnedExampleSchema = z.object({
  signal: z.enum(["deleted", "restored", "copied"]),
  category: categorySchema,
  trigger: z.string().max(80),
  why: z.string().max(80),
  quote: z.string().max(160),
});

export const judgeRequestSchema = z.object({
  runId: runIdSchema,
  mode: z.enum(["session", "backfill"]),
  session: z.object({
    id: idSchema,
    kind: z.enum(["in_app", "import", "backfill"]),
    startedAt: z.string().max(40),
    timeZone: z.string().max(60),
    place: z.string().max(80).optional(),
  }),
  window: judgeWindowSchema,
  sessionNotes: z.string().max(400),
  profile: profileInputSchema,
  learnedExamples: z.array(learnedExampleSchema).max(6),
  todayKept: z.array(z.string().max(160)).max(20),
  memoryIndex: z.array(z.string().max(240)).max(300),
  nearbyItems: z
    .array(z.object({ id: idSchema, name: z.string().max(80), place: z.string().max(120), time: z.string().max(40) }))
    .max(40)
    .optional(),
});
export type JudgeRequest = z.infer<typeof judgeRequestSchema>;

/** 模型交卷的单个片段。字数上限比 spec 宽，超出部分由守卫截断，不因为多一个字整轮失败。 */
export const modelMomentSchema = z.object({
  sourceUtteranceIds: z.array(z.string().min(1)).min(1).max(40),
  decision: decisionSchema,
  category: categorySchema,
  salience: z.number().min(0).max(1),
  trigger: z.string().max(80),
  why: z.string().max(80),
  othersParaphrase: z.string().max(120).optional(),
  facts: z.array(z.object({ entity: z.string().max(40), fact: z.string().max(160) })).max(3).optional(),
  backfillTarget: z
    .object({ dayKey: z.string().max(20), place: z.string().max(80).optional(), confidence: z.number().min(0).max(1) })
    .optional(),
});
export type ModelMoment = z.infer<typeof modelMomentSchema>;

export const judgeSubmitSchema = z.object({
  moments: z.array(modelMomentSchema).max(30),
  sessionNotes: z.string().max(400),
});
export type JudgeSubmit = z.infer<typeof judgeSubmitSchema>;

export const triageRequestSchema = z.object({
  runId: runIdSchema,
  window: judgeWindowSchema,
});
export const triageOutputSchema = z.object({
  action: z.enum(["judge", "skip"]),
  reason: z.string().max(80),
});

// ── 写作 ─────────────────────────────────────────────────────────────

export const writeMomentSchema = z.object({
  id: idSchema,
  heading: z.string().max(60),
  myQuotes: z.array(z.string().max(2_500)).min(1).max(30),
  othersParaphrase: z.string().max(120).optional(),
  trigger: z.string().max(80),
  salience: z.number().min(0).max(1),
  /** 用户改过措辞的段落：原样保留，不进写作 */
  userEditedText: z.string().max(600).optional(),
});

export const writeRequestSchema = z.object({
  runId: runIdSchema,
  dayKey: dayKeySchema,
  moments: z.array(writeMomentSchema).min(1).max(8),
  profile: profileInputSchema,
  /** 前端给的剩余时间预算（毫秒）：不够就跳过重写，直接降级（spec v3 阶段预算） */
  budgetMs: z.number().int().min(5_000).max(55_000).optional(),
});
export type WriteRequest = z.infer<typeof writeRequestSchema>;

export const writerOutputSchema = z.object({
  title: z.string().max(40),
  quotes: z.array(z.object({ momentId: z.string(), text: z.string().max(120) })).max(6),
  paragraphs: z.array(z.object({ momentId: z.string(), text: z.string().max(600) })).max(8),
});
export type WriterOutput = z.infer<typeof writerOutputSchema>;

export const verifierOutputSchema = z.object({
  results: z
    .array(
      z.object({
        momentId: z.string(),
        claims: z.array(z.object({ claim: z.string().max(200), support: z.string().max(40) })).max(20),
        unsupported: z.array(z.string().max(200)).max(20),
      }),
    )
    .max(8),
});
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;

// ── 学习 ─────────────────────────────────────────────────────────────

export const reflectEventSchema = z.object({
  id: idSchema,
  type: z.enum(["delete", "restore", "copy", "edit"]),
  moment: z.object({
    momentId: idSchema,
    category: categorySchema,
    decision: decisionSchema,
    trigger: z.string().max(80),
    why: z.string().max(80),
    quotes: z.array(z.string().max(200)).max(3),
  }),
  before: z.string().max(600).optional(),
  after: z.string().max(600).optional(),
});

export const reflectRequestSchema = z.object({
  runId: runIdSchema,
  profile: profileInputSchema.extend({
    rules: z.array(profileRuleInputSchema.extend({ evidenceMomentIds: z.array(z.string()).max(20), active: z.boolean() })).max(80),
  }),
  events: z.array(reflectEventSchema).min(1).max(30),
});
export type ReflectRequest = z.infer<typeof reflectRequestSchema>;

export const reflectOpSchema = z.object({
  op: z.enum(["add", "update", "deactivate"]),
  ruleId: z.string().max(160).optional(),
  kind: z.enum(["keep", "drop", "style"]),
  text: z.string().max(80),
  evidenceMomentIds: z.array(z.string()).min(1).max(20),
});
export type ReflectOp = z.infer<typeof reflectOpSchema>;

export const reflectOutputSchema = z.object({
  ops: z.array(reflectOpSchema).max(8),
  summary: z.string().max(160),
});
