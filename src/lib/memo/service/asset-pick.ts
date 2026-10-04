// 以声定图的"多选一"（外部设备接入工单 v2 Gate 2）：同一时刻窗口里有 2–3 张候选时，
// 客户端把缩略图拼成一张带编号的图，这里交给识图模型，配上用户那句原话，选一张或一张都不选。
// 只有 1 张候选时客户端直接用，不调这里。不对的时候宁可不选：留白好过配错图。
import { z } from "zod";
import { withModelSlot } from "../../agent/limiter";
import { TraceBuilder } from "../../agent/trace";
import { extractJsonObject } from "../../json";
import { callVision, defaultVisionModel, visionProvider } from "../../llm";
import type { AgentTrace } from "../types";

export const assetPickRequestSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_:.-]{4,120}$/),
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  momentId: z.string().min(1).max(200),
  /** 用户那句原话（已经是"我"说的、去过口令的） */
  quote: z.string().min(1).max(300),
  trigger: z.string().max(80).default(""),
  count: z.number().int().min(2).max(3),
  /** 拼好的候选图（JPEG data URL），编号 1..count 从左到右 */
  sheet: z.string().startsWith("data:image/jpeg;base64,").max(900_000),
});
export type AssetPickRequest = z.infer<typeof assetPickRequestSchema>;

const answerSchema = z.object({ pick: z.number().int().min(0).max(3), reason: z.string().max(200).default("") });

const SYSTEM = `你在帮用户给旅行手帐配图。图里从左到右并排放了几张照片，左上角标了编号 1、2、3。
用户在拍这些照片的前后说了一句话。请判断哪一张照片拍的就是这句话说的东西。
- 只能根据画面判断，不要猜；都对不上就选 0。
- 只输出一个 JSON 对象：{"pick": 编号或 0, "reason": "不超过 30 字的理由"}，不要代码块，不要别的文字。`;

export async function pickAsset(req: AssetPickRequest): Promise<{ pick: number; reason: string; trace: AgentTrace }> {
  const trace = new TraceBuilder("match", req.momentId, { runId: req.runId, dayKey: req.dayKey });
  const model = defaultVisionModel();
  trace.setModel(model);
  if (visionProvider() !== "zhipu") trace.markEstimated();
  const startedAt = Date.now();
  const raw = await withModelSlot(() =>
    callVision({
      imageDataUrl: req.sheet,
      systemPrompt: SYSTEM,
      userText: `一共 ${req.count} 张照片。用户说的话：「${req.quote}」${req.trigger ? `（触发它的东西：${req.trigger}）` : ""}`,
      imageDetail: "low",
      model,
      jsonMode: true,
      timeoutMs: 45_000,
    }),
  );
  let parsed: z.infer<typeof answerSchema>;
  try {
    parsed = answerSchema.parse(extractJsonObject(raw));
  } catch {
    trace.push({ kind: "check", name: "asset_pick_parse", ms: Date.now() - startedAt, summary: "识图模型的回答解析不了，按「都对不上」处理" });
    return { pick: 0, reason: "", trace: trace.build("degraded") };
  }
  const pick = parsed.pick <= req.count ? parsed.pick : 0;
  trace.push({
    kind: "model",
    name: model,
    ms: Date.now() - startedAt,
    summary: pick ? `${req.count} 张候选里选了第 ${pick} 张：${parsed.reason}` : `${req.count} 张候选都对不上这句话${parsed.reason ? `：${parsed.reason}` : ""}`,
  });
  return { pick, reason: parsed.reason, trace: trace.build("ok") };
}
