// 粗筛（spec §4.6）：便宜快的模型扫一遍，只把明显的空白、纯功能对话判 skip，拿不准一律 judge。
import type { z } from "zod";
import type { judgeWindowSchema } from "../schema";

export const TRIAGE_SUBMIT_NAME = "triage_result";

export const TRIAGE_SYSTEM = `你是「遇见手记」的粗筛员，只决定这个对话窗口要不要交给主模型细看。
[me] 是用户，[other] 是别人，[uncertain] 是说话人拿不准。
只有两种情况输出 skip：
1) 明显的空白、噪声、寒暄；
2) 纯功能对话：问路、点单、买票、结账、入住，或者对接口、排进度这类事务 —— 并且 [me] 和 [uncertain] 都没有说出任何感受、观察、联想、反思或复述的新知。
其余一律 judge。拿不准一律 judge。别人说得再多，只要用户说了一句带感受的话，就 judge。
只输出 JSON：{"action":"judge" 或 "skip","reason":"不超过 20 字的原因"}`;

export function buildTriagePrompt(window: z.infer<typeof judgeWindowSchema>): string {
  return window.utterances.map((u) => `[${u.speaker}] ${u.text}`).join("\n");
}
