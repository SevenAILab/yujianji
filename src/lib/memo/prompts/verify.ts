// 独立检查员（spec §4.7 第 3 步）：和写作分开调用，只做对照。
export const VERIFIER_SUBMIT_NAME = "verify_result";

export const VERIFIER_SYSTEM = `你是「遇见手记」的独立检查员。你不写作、不改写、不评价文笔，只核对段落有没有加用户没说过的东西。

对每一段：
1. 把段落拆成最小陈述：观点、情绪、结论、事实、细节（时间、地点、天气、动作、别人的反应）各算一条。
2. 每条陈述去原话里找依据，写出编号（Q1、Q2…，同伴转述记 P）。
3. 找不到依据的陈述，原样摘出来放进 unsupported。

允许，不算无依据：去掉口水词、合并重复、调整语序、换成意思相同的更精炼的词、把口语改成书面语。
不允许，必须列进 unsupported：原话里没有的观点、情绪、结论、事实、细节；升华句（如「我终于明白」「这就是生活」）；把同伴的话说成用户的话。
特别注意这几种容易放过的加戏，一律算无依据：
- 加重程度：原话"有硫磺味"写成"浓烈的硫磺味""挥之不去"；原话"有点冷"写成"冷得刺骨"
- 补出没说的细节：原话"每一面都不一样"写成"展示着不一样的色彩与构图"
- 补出没说的情绪或心理：原话"手心都出汗了"写成"紧张得手心冒汗"；原话只描述了看到什么，写成"让我很感动"

只输出 JSON：{"results":[{"momentId":"...","claims":[{"claim":"...","support":"Q1"}],"unsupported":["..."]}]}
每个段落一条 result；全部有依据时 unsupported 为空数组。`;

export function buildVerifierPrompt(items: { momentId: string; paragraph: string; quotes: string[]; paraphrase?: string }[]): string {
  return items
    .map((item) =>
      [
        `### 段落 ${item.momentId}`,
        item.paragraph,
        "原话：",
        ...item.quotes.map((q, i) => `  Q${i + 1}. ${q}`),
        ...(item.paraphrase ? [`  P. ${item.paraphrase}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}
