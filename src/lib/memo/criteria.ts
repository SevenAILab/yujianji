// 判断标准：逐字取自 tasks/2026-09-12-遇见手记-产品与Agent方案.md §3（v2，9/15 确认）。
// 改这里之前先改方案；测试集（eval/memo/judge）不得复用下面 few-shot 里的句子。
import type { KeepCategory, DropCategory, SpeakerRole } from "./types";

export const CRITERIA_TEXT = `**唯一前提：是你自己说出口的。** 别人说得再精彩，你没有说出自己的想法，就不留。

### 留
| 类型 | 你的例子 |
|---|---|
| 看到的差异和新鲜：文化、生活方式、习惯 | "这边吃完饭都不给小费，服务员也不会给你脸色看。" |
| 带着感受的观察 | "那个老爷爷一个人坐在长椅上喂鸽子，看起来好满足啊。" |
| 看到东西想起过去 | "这个颜色好像小时候外婆家的窗帘。" |
| 反思、对自己的冲击、想做的改变 | "我突然觉得我们平时太着急了，吃个饭都在看手机。" "回去之后我想少接点活，给自己留点空。" 英国人躺在草坪上晒太阳 vs 国内觉得休息可耻、996、下班还要做账号 |
| 第一次的体验和评价 | "这个冰淇淋是我吃过最好吃的。" |
| 你复述出来、打动了你的新知 | "导游刚说这座桥修了三百年，现在还在用。" |

### 丢
| 类型 | 例子 |
|---|---|
| 功能性事务：问路、点单、买票、砍价、入住 | "麻烦问一下，地铁站怎么走？" |
| 对行程、服务、身体的抱怨 | "天啊排了一个小时队，腿都要断了。" "早知道不订这家酒店了，隔音太差。" |
| 别人讲得精彩，但你没说出自己的想法 | 朋友："他们四点就下班了，下了班是真的不回消息。" 你："真的假的？" |
| 导游、讲解员、广播的原始讲解 | — |
| 电话、背景人声、广播、音乐 | — |
| 私密：感情关系、身体、具体收入 | "我跟他分手，就是因为他从来不陪我出来玩。" |
| 事务性的工作讨论：对接口、排进度、谈合作条款 | 示例（不是你的原话）："接口明天几点对一下？" |

### 四条边界
1. **抱怨 vs 反思**：针对当下的不方便，丢；上升到文化或自己的生活方式，留。
2. **隐私 vs 自我反思**：具体的感情、身体、钱，丢；对工作节奏、生活方式的反思，留。
3. **讲解 vs 复述**：讲解员的原话，丢；你自己复述出来的，留 —— 复述本身就说明它打动了你。
4. **工作事务 vs 新场合里的感受**：看"说的是什么"，不看"在什么场合"。事务性的工作讨论（对接口、排进度、谈条款），丢；在新场合里对人和事的感受，留。示例（不是你的原话）："接口明天几点对一下"丢；"第一次见到这么多 coser，像走进了动画片"留。黑客松现场的录音就靠这一条区分。

同伴的话只在引出你的感想时出现，并且只以转述加署名的形式出现。`;

export interface FewShot {
  title: string;
  utterances: { id: string; speaker: SpeakerRole; text: string }[];
  expect: { ids: string[]; decision: "keep" | "fold" | "drop"; category: KeepCategory | DropCategory }[];
  reason: string;
}

/** 方案 §3 表格里的全部例子 + 第 4 条边界示例 + 说话人三态示例，每个写成迷你窗口 */
export const FEW_SHOTS: FewShot[] = [
  { title: "差异和新鲜", utterances: [{ id: "a1", speaker: "me", text: "这边吃完饭都不给小费，服务员也不会给你脸色看。" }], expect: [{ ids: ["a1"], decision: "keep", category: "difference" }], reason: "你注意到了和国内习惯的差异" },
  { title: "带感受的观察", utterances: [{ id: "b1", speaker: "me", text: "那个老爷爷一个人坐在长椅上喂鸽子，看起来好满足啊。" }], expect: [{ ids: ["b1"], decision: "keep", category: "observation" }], reason: "看到的人，带着你的感受" },
  { title: "想起过去", utterances: [{ id: "c1", speaker: "me", text: "这个颜色好像小时候外婆家的窗帘。" }], expect: [{ ids: ["c1"], decision: "keep", category: "memory" }], reason: "眼前的东西让你想起过去" },
  { title: "反思", utterances: [{ id: "d1", speaker: "me", text: "我突然觉得我们平时太着急了，吃个饭都在看手机。" }, { id: "d2", speaker: "other", text: "是啊。" }, { id: "d3", speaker: "me", text: "回去之后我想少接点活，给自己留点空。" }], expect: [{ ids: ["d1", "d3"], decision: "keep", category: "reflection" }], reason: "对自己生活节奏的反思和想做的改变" },
  { title: "反思（上升到生活方式）", utterances: [{ id: "e1", speaker: "me", text: "他们就躺在草坪上晒太阳，好 chill。" }, { id: "e2", speaker: "me", text: "在国内总觉得休息是可耻的，996，下了班还要做账号。" }], expect: [{ ids: ["e1", "e2"], decision: "keep", category: "reflection" }], reason: "看到别人的松弛，想到自己的生活方式" },
  { title: "第一次的体验", utterances: [{ id: "f1", speaker: "me", text: "这个冰淇淋是我吃过最好吃的。" }], expect: [{ ids: ["f1"], decision: "keep", category: "first_experience" }], reason: "第一次的体验和你的评价" },
  { title: "复述的新知", utterances: [{ id: "g1", speaker: "other", text: "（导游）这座桥修建于三百年前，至今仍在通行。" }, { id: "g2", speaker: "me", text: "导游刚说这座桥修了三百年，现在还在用。" }], expect: [{ ids: ["g1"], decision: "drop", category: "guide" }, { ids: ["g2"], decision: "keep", category: "retold_fact" }], reason: "讲解原话丢；你自己复述出来，说明打动了你" },
  { title: "功能性事务", utterances: [{ id: "h1", speaker: "me", text: "麻烦问一下，地铁站怎么走？" }], expect: [{ ids: ["h1"], decision: "drop", category: "functional" }], reason: "问路，功能性事务" },
  { title: "对当下不便的抱怨", utterances: [{ id: "i1", speaker: "me", text: "天啊排了一个小时队，腿都要断了。" }, { id: "i2", speaker: "me", text: "早知道不订这家酒店了，隔音太差。" }], expect: [{ ids: ["i1", "i2"], decision: "drop", category: "complaint" }], reason: "针对当下不方便的抱怨，没有上升到反思" },
  { title: "别人说得精彩，你没说出想法", utterances: [{ id: "j1", speaker: "other", text: "他们四点就下班了，下了班是真的不回消息。" }, { id: "j2", speaker: "me", text: "真的假的？" }], expect: [{ ids: ["j1", "j2"], decision: "drop", category: "others_only" }], reason: "精彩的是朋友的话，你只回了一句" },
  { title: "私密", utterances: [{ id: "k1", speaker: "me", text: "我跟他分手，就是因为他从来不陪我出来玩。" }], expect: [{ ids: ["k1"], decision: "drop", category: "private" }], reason: "具体的感情关系，隐私底线" },
  { title: "第 4 条边界：工作事务", utterances: [{ id: "l1", speaker: "me", text: "接口明天几点对一下？" }], expect: [{ ids: ["l1"], decision: "drop", category: "work_task" }], reason: "事务性的工作讨论（示例，不是你的原话）" },
  { title: "第 4 条边界：新场合里的感受", utterances: [{ id: "m1", speaker: "me", text: "第一次见到这么多 coser，像走进了动画片。" }], expect: [{ ids: ["m1"], decision: "keep", category: "first_experience" }], reason: "看说的是什么：新场合里对人和事的感受（示例，不是你的原话）" },
  { title: "说话人拿不准", utterances: [{ id: "n1", speaker: "uncertain", text: "这里的人走路都好慢，一点都不赶。" }], expect: [{ ids: ["n1"], decision: "fold", category: "observation" }], reason: "内容值得留，但拿不准是不是你说的，先折叠" },
];

export function renderFewShots(shots = FEW_SHOTS): string {
  return shots
    .map((shot, i) => {
      const lines = shot.utterances.map((u) => `  ${u.id} [${u.speaker}] ${u.text}`).join("\n");
      const expects = shot.expect.map((e) => `${e.ids.join("+")} → ${e.decision} / ${e.category}`).join("；");
      return `例 ${i + 1}（${shot.title}）\n${lines}\n  判定：${expects}\n  理由：${shot.reason}`;
    })
    .join("\n\n");
}
