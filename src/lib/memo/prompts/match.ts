// 日终补配图（工单 Gate 1.2）：给还没配图的片段，从当天照片里按内容挑一张。
// 照片只有识别名称、类别、地点、时间——模型看不到图片本身，只能按名字判断是不是同一个东西。
import type { MatchRequest } from "../schema";

export const MATCH_SUBMIT_NAME = "submit_matches";

export const MATCH_SYSTEM = `你是「遇见手记」的配图员。用户一天里说过一些话、拍过一些照片，你要判断哪句话讲的正是哪张照片里的东西。
你看不到照片本身，只知道每张照片被识别成了什么（名称、类别）、在哪、几点拍的。

规则：
1. 只有照片的名称就是这段话正在讲的那个东西时才配。"瑞幸咖啡"配"瑞幸咖啡杯"可以；话里讲悬崖、照片是盆栽，不行。
2. 时间和地点只是参考，不能当理由。时间接近不等于内容相关：用户可能刚拍完一样东西，嘴里讲的是别的。
3. 一段话最多配一张，一张照片最多配一段。拿不准就不配，留白远好过配错。
4. reason 用一句话说明两者为什么是同一个东西，不超过 30 字。
5. 没有任何能配上的，就交一个空的 matches。

最后调用 ${MATCH_SUBMIT_NAME} 交卷。`;

export function buildMatchPrompt(req: MatchRequest): string {
  return [
    `## ${req.dayKey} 还没配图的片段`,
    ...req.moments.map((m) => `- ${m.id} ｜ ${m.time} ｜ ${m.place} ｜ 触发：${m.trigger} ｜ 原话：${m.quote}`),
    "",
    "## 当天的照片（只能从这里选）",
    ...req.photos.map((p) => `- ${p.id} ｜ ${p.name}${p.category ? `（${p.category}）` : ""} ｜ ${p.time} ｜ ${p.place}`),
    "",
    `逐段判断，最后调用 ${MATCH_SUBMIT_NAME} 交卷。`,
  ].join("\n");
}
