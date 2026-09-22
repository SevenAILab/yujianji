// 判断提示词（spec §4.6）：结构借鉴 Omi extract_memories_prompt —— 按顺序回答判定题、每类配 ✅ / ❌ 例子、输出不写说话人编号；
// 标准逐字取自方案 §3（criteria.ts）。只借结构，不照搬：我们的标准更严，别人说的、用户没回应的一律丢。
import { CRITERIA_TEXT, renderFewShots } from "../criteria";
import type { LearnedExample } from "../learning";
import { CATEGORY_LABELS, type JudgeRequest } from "../schema";
import { clockIn, dayKeyIn } from "../time";

export const JUDGE_SUBMIT_NAME = "submit_judgement";
export const JUDGE_SUBMIT_DESCRIPTION = "交卷：判断完成后必须调用它，一次提交这个窗口的全部片段和本场笔记。调用后本轮结束。";

const QUESTIONS = `每个片段都从第 1 问开始，前一问有结论就停，不要跳题。

第 1 问：这段内容是用户自己说出口的吗？看每句前面的标记：[me] 是用户，[other] 是别人，[uncertain] 是说话人拿不准。
  - 来源句全是 [other]，或者用户只回了「真的假的」「嗯」「对啊」这类没有自己想法的话 → drop，category = others_only。
  - 来源句里没有 [me]、只有 [uncertain] → 最多 fold，不能 keep；why 写「拿不准是不是你说的」。
  - ✅ [me] 说出了自己的想法、感受、观察 → 进入第 2 问
  - ❌ [other] 讲得很精彩，[me] 只附和一句 → drop / others_only

第 2 问：它只是功能性事务、对当下不便的抱怨、讲解原话、背景声、私密细节、事务性工作讨论，而没有上升到对差异、对自己的感受或反思吗？是 → drop，category 标对应丢类。
  - ✅ drop / functional：问路、点单、买票、结账、入住
  - ✅ drop / complaint：只针对当下的排队、交通、住宿、身体不舒服
  - ✅ drop / guide：讲解员、导游、广播的原始讲解（用户自己复述的不算）
  - ✅ drop / background：电话、背景人声、广播、音乐
  - ✅ drop / private：具体的感情关系、身体、收入 —— 说得再动情也丢
  - ✅ drop / work_task：对接口、排进度、谈合作条款
  - ❌ 不是纯抱怨：抱怨引出了对文化或自己生活方式的比较和反思 → 进入第 3 问
  - ❌ 不是纯工作：看"说的是什么"，不看"在什么场合"；在新场合里对人和事的感受 → 进入第 3 问

第 3 问：它是被新鲜的人、事、景触发的差异、带感受的观察、联想、反思、第一次的体验、复述出来的新知吗？是 → keep，category 标对应留类。
  - ✅ keep / difference：注意到文化、生活方式、习惯和自己熟悉的不一样
  - ✅ keep / observation：看到的人和景，带着自己的感受
  - ✅ keep / memory：眼前的东西让自己想起过去
  - ✅ keep / reflection：对自己的冲击、反思、想做的改变
  - ✅ keep / first_experience：第一次的体验和评价
  - ✅ keep / retold_fact：自己复述出来、打动了自己的新知
  - ❌ 只是陈述一个事实、没有任何感受或新鲜感 → 不 keep

都不明确 → fold，在 why 里写清原因。`;

function toolsSection(maxToolCalls: number, hasPhotos: boolean, hasMemory: boolean): string {
  return [
    ...(hasMemory ? ["- recall_memory：翻用户过去留下和折叠的片段索引。mode=backfill（补一段）时必须先调用，用它确定说的是哪天、哪个地方；判断时怀疑和今天或以前的内容重复，也可以调用。"] : []),
    "- lookup_fact：只在用户提到具体实体（地名、建筑、菜名、历史），补一句背景能让手记更好时调用；返回的事实会标「AI 补充，未经核实」。",
    ...(hasPhotos
      ? [
          "- find_photos：**配图用不着它**——候选照片已经列在下面了，直接挑。只有 mode=backfill 要推断是哪天、哪个地方时才调用。",
        ]
      : []),
    `- 业务工具合计最多 ${maxToolCalls} 次，不需要就一次都不调。工具返回 {"error": ...} 时，自己决定换参数重试还是放弃。`,
    `- 最后必须调用 ${JUDGE_SUBMIT_NAME} 交卷。`,
  ].join("\n");
}

function outputRules(mode: JudgeRequest["mode"]): string {
  return [
    "- sourceUtteranceIds 必须是本窗口里句子前面的 id（如 u3），非空；一个片段通常 1–4 句，围绕同一个触发点。同一句不要出现在两个片段里。",
    "- 要交的片段：所有 keep、fold，以及值得在过程页说明的 drop（功能、抱怨、工作、私密、别人说的）；纯噪声、寒暄可以不交。",
    "- trigger ≤ 30 字：是什么触发了这段话。why ≤ 30 字：给用户看的一句「为什么留下 / 为什么折叠」，用「你」称呼用户。",
    "- salience 0–1：keep 越具体、越打动人越高（0.5–1）；fold 0.2–0.5；drop 0–0.2。",
    "- othersParaphrase（可选）：同伴的话引出了用户的感想时填，写成转述 + 署名，如「朋友说他们四点就下班」，≤ 40 字，不加引号，不照抄原话。",
    "- facts（可选）：只能填 lookup_fact 这一轮真实返回过的内容，entity 与调用时一致。",
    "- photoId（可选）：**只有照片的名字就是这段话正在讲的那个东西时**才填，从上面给的候选里抄 id。",
    "  只有 observation / first_experience / difference 这三类能配图——它们讲的是眼前看到的东西。",
    "  reflection、memory、retold_fact 讲的是心里的事，**一律不配图**，哪怕同一时间恰好拍了照片。",
    "  时间接近不等于内容相关：用户可能刚拍完一盆植物，嘴里讲的是别处的悬崖。对不上就别填，留白远好过配错。",
    "  每段最多一张，drop 的片段一律不填，同一张图不要给两段。",
    "- 不要复述用户原话（代码会按 id 取原文）；任何字段里都不要出现「说话人 0 / 1」「speaker」「[me]」这类标记。",
    "- 拿不准就用 fold，并在 why 写原因。",
    ...(mode === "backfill"
      ? [
          "- mode=backfill：每个 keep / fold 片段必须填 backfillTarget {dayKey: \"YYYY-MM-DD\", place, confidence 0–1}。dayKey 和 place 必须原样取自 recall_memory 返回的某一行索引（说的是过去某天某地的事），不能用补录当天的日期或窗口里的泛称（如「街头」「湖边」）；换关键词多查一次仍对不上，就 confidence 给 0.3 以下，不要猜。",
        ]
      : []),
    "- sessionNotes ≤ 300 字：本场笔记（在哪、和谁、刚才聊到哪、用户关心什么），给下一个窗口接上下文；不写原话。",
  ].join("\n");
}

export function buildJudgeSystem(opts: {
  mode: JudgeRequest["mode"];
  maxToolCalls: number;
  hasPhotos: boolean;
  hasMemory?: boolean;
  rules: { kind: string; text: string; origin: string }[];
  examples: LearnedExample[];
}): string {
  const personal = opts.rules.filter((r) => r.kind !== "style" && r.origin !== "seed");
  const personalText = personal.map((r) => `- [${r.origin === "user" ? "你手写" : "学到"}·${r.kind === "drop" ? "不留" : "要留"}] ${r.text}`).join("\n");
  const seedText = opts.rules
    .filter((r) => r.kind !== "style" && r.origin === "seed")
    .map((r) => `- ${r.text}`)
    .join("\n");
  const signalLabel = { deleted: "用户删掉了", restored: "用户从折叠区捞回了", copied: "用户复制了" } as const;
  const examples = opts.examples
    .map((e) => `- ${signalLabel[e.signal]}：${CATEGORY_LABELS[e.category]} · ${e.trigger}${e.quote ? ` · 原话摘要「${e.quote}」` : ""}`)
    .join("\n");

  // 学到的 / 用户手写的规则放在最前面单独成步：实验室 3 轮重跑里，规则埋在末尾时有 1 轮被忽略
  return `你是「遇见手记」的判断 Agent。录音的主人是用户；下面判断标准里的「你」都指用户。
任务：读一个对话窗口，挑出值得写进用户旅行手记的片段，逐个给出 keep（进手记正文候选）/ fold（折叠，用户可以捞回）/ drop（不留）。

## 第 0 步：先对照「它眼中的我」里用户自己的偏好
${personal.length ? `下面是从用户的删除、捞回里学到的，或用户亲手写的规则。片段命中「不留」规则 → 直接 drop（category 保留最接近的类型），why 写「你之前删掉过这类」；命中「要留」规则 → 至少 fold。它们优先于下面的留类判断；但唯一前提（必须是用户自己说的）和隐私底线永远优先于它们。\n${personalText}` : "（用户还没有自己的偏好规则，直接按判断标准判。）"}
${examples ? `\n从用户操作里挑出的例子：\n${examples}` : ""}

## 判断标准（产品方案 §3 原文）
${CRITERIA_TEXT}

## 按顺序回答判定题
${QUESTIONS}

## 例子
${renderFewShots()}

## 工具
${toolsSection(opts.maxToolCalls, opts.hasPhotos, opts.hasMemory ?? true)}

## 交卷要求
${outputRules(opts.mode)}

## 种子画像（判断标准的简写，供对照）
${seedText || "（无）"}`;
}

function mmss(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 句子 id 换成 u0、u1…，模型只抄短 id，服务端再换回真实 id */
export function buildJudgeUserPrompt(req: JudgeRequest, shortIds: Map<string, string>): string {
  const kindLabel = { in_app: "App 内录音", import: "导入的录音", backfill: "补一段（事后感想）" }[req.session.kind];
  const started = `${dayKeyIn(req.session.startedAt, req.session.timeZone)} ${clockIn(req.session.startedAt, req.session.timeZone)}`;
  const lines = req.window.utterances.map((u) => `${shortIds.get(u.id)} [${mmss(u.offsetMs)}] [${u.speaker}] ${u.text}`);
  return [
    `mode: ${req.mode}`,
    `会话：${kindLabel} · 开始于 ${started}（${req.session.timeZone}）${req.session.place ? ` · 地点：${req.session.place}` : " · 地点未知"}`,
    `本场笔记（上一个窗口留下的）：${req.sessionNotes || "（这是第一个窗口）"}`,
    `今天已经留下的片段（避免重复）：${req.todayKept.length ? `\n${req.todayKept.map((line) => `- ${line}`).join("\n")}` : "（还没有）"}`,
    `记忆索引：共 ${req.memoryIndex.length} 条，需要时用 recall_memory 查。`,
    ...(req.nearbyItems?.length
      ? [
          "",
          "## 这段时间前后你拍的照片（配图只能从这里选）",
          ...req.nearbyItems
            .slice(0, 10)
            .map((item) => `- ${item.id} ｜ ${item.name} ｜ ${clockIn(item.time, req.session.timeZone)}${item.place ? ` ｜ ${item.place}` : ""}`),
        ]
      : []),
    "",
    `## 窗口（按时间顺序，[mm:ss] 是相对录音开始的时间）`,
    ...lines,
    "",
    `请按判定题逐个判断，最后调用 ${JUDGE_SUBMIT_NAME} 交卷。`,
  ].join("\n");
}
