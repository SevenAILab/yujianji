import { describe, expect, it } from "vitest";
import {
  ENCOUNTER_AV_SYSTEM_PROMPT,
  RECOGNIZE_SYSTEM_PROMPT,
} from "../src/lib/prompt";

/**
 * 门 E 的回归防护。
 *
 * 追问必须长在用户说的话上，不是长在照片上——这是实测出来的结论
 * （旧 prompt 会问「叶脉结构是羽状还是掌状」，用户答不上也不想答）。
 * prompt.ts 还会被继续改，这组断言防止这条规则被无声改回去。
 */
const REQUIRED = [
  "锚点是用户",
  "只有他自己知道答案",
  "禁止知识型问题",
  "禁止空泛感受题",
  "不要预设他做过某个动作",
  "不超过 25 个汉字",
];

describe("question 追问规则", () => {
  it("照片链路带全部追问规则", () => {
    for (const rule of REQUIRED) {
      expect(RECOGNIZE_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("视频链路带同一套追问规则", () => {
    for (const rule of REQUIRED) {
      expect(ENCOUNTER_AV_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("旧的空话式规则已经被替换掉", () => {
    const stale = "question 只能问一个具体问题";
    expect(RECOGNIZE_SYSTEM_PROMPT).not.toContain(stale);
    expect(ENCOUNTER_AV_SYSTEM_PROMPT).not.toContain(stale);
  });

  it("两条链路都要求中文且限长", () => {
    for (const prompt of [RECOGNIZE_SYSTEM_PROMPT, ENCOUNTER_AV_SYSTEM_PROMPT]) {
      expect(prompt).toContain("必须全部使用中文");
      expect(prompt).toContain("混入任何英文单词");
    }
  });
});
