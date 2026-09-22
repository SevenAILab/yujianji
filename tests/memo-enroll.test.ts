import { describe, expect, it } from "vitest";
import { assignSpeakerRoles } from "../src/lib/memo/speaker";

/**
 * 声纹注册的服务端逻辑：注册音频拼在每个 ASR 分段前面，
 * 落在前 enrollMs 毫秒里的说话人就是"我"；注册段本身要剥掉，剩下的整体回正。
 * 这里把 jobs.ts 里那段纯计算抄成可测的函数——改 jobs.ts 时两边要同步。
 */
function meAndSentences(
  partIndex: number,
  raw: { beginMs: number; endMs: number; speakerId: string; text: string }[],
  enrollMs: number,
  offsetMs = 0,
) {
  let meKey: string | null = null;
  if (enrollMs > 0) {
    const talk = new Map<string, number>();
    for (const s of raw) {
      if (s.beginMs >= enrollMs) continue;
      const ms = Math.min(s.endMs, enrollMs) - s.beginMs;
      if (ms > 0) talk.set(s.speakerId, (talk.get(s.speakerId) ?? 0) + ms);
    }
    let bestMs = 0;
    for (const [id, ms] of talk) if (ms > bestMs) { meKey = `${partIndex}:${id}`; bestMs = ms; }
  }
  const sentences = raw
    .filter((s) => !(enrollMs > 0 && s.endMs <= enrollMs))
    .map((s) => ({
      beginMs: Math.max(0, s.beginMs - enrollMs) + offsetMs,
      endMs: Math.max(0, s.endMs - enrollMs) + offsetMs,
      speakerKey: `${partIndex}:${s.speakerId}`,
      text: s.text,
    }))
    .filter((s) => s.endMs > s.beginMs);
  return { meKey, sentences };
}

const ENROLL = 8_000;

describe("声纹注册：定我与时间轴回正", () => {
  const part0 = [
    { beginMs: 300, endMs: 7_600, speakerId: "1", text: "我今天来深圳会展中心逛漫展" }, // 注册段
    { beginMs: 9_000, endMs: 12_000, speakerId: "1", text: "第一次见到这么多 coser" },
    { beginMs: 12_500, endMs: 15_000, speakerId: "2", text: "那是原神的角色" },
  ];

  it("注册段所属的说话人就是我", () => {
    expect(meAndSentences(0, part0, ENROLL).meKey).toBe("0:1");
  });

  it("注册段的句子被剥掉，不进逐字稿", () => {
    const { sentences } = meAndSentences(0, part0, ENROLL);
    expect(sentences).toHaveLength(2);
    expect(sentences.some((s) => s.text.includes("我今天来深圳会展中心"))).toBe(false);
  });

  it("剩下的句子整体回正，没有负数时间", () => {
    const { sentences } = meAndSentences(0, part0, ENROLL);
    expect(sentences[0].beginMs).toBe(1_000);
    expect(sentences.every((s) => s.beginMs >= 0 && s.endMs > s.beginMs)).toBe(true);
  });

  it("没有注册音频时原样通过", () => {
    const { meKey, sentences } = meAndSentences(0, part0, 0);
    expect(meKey).toBeNull();
    expect(sentences).toHaveLength(3);
    expect(sentences[0].beginMs).toBe(300);
  });

  it("分段偏移叠加在回正之后", () => {
    const { sentences } = meAndSentences(1, part0, ENROLL, 6_600_000);
    expect(sentences[0].beginMs).toBe(6_601_000);
  });
});

describe("多分段：每段各自定我", () => {
  // 关键：speakerId 在不同分段之间不可比。第 0 段的"我"是 1，第 1 段可能变成 0。
  it("两段各自命中，两段都判出我", () => {
    const a = meAndSentences(0, [
      { beginMs: 200, endMs: 7_500, speakerId: "1", text: "注册" },
      { beginMs: 9_000, endMs: 12_000, speakerId: "1", text: "我说的" },
      { beginMs: 12_500, endMs: 14_000, speakerId: "0", text: "别人说的" },
    ], ENROLL);
    const b = meAndSentences(1, [
      { beginMs: 100, endMs: 7_800, speakerId: "0", text: "注册" },
      { beginMs: 9_000, endMs: 12_000, speakerId: "0", text: "我说的" },
      { beginMs: 12_500, endMs: 14_000, speakerId: "1", text: "别人说的" },
    ], ENROLL, 6_600_000);
    expect([a.meKey, b.meKey]).toEqual(["0:1", "1:0"]);

    // 交给 assignSpeakerRoles：两段的"我"都要被认出来，不能只认第 0 段
    const r = assignSpeakerRoles(
      [
        { key: "0:0", meanDb: -24, talkMs: 1_500 },
        { key: "0:1", meanDb: -29, talkMs: 3_000 },
        { key: "1:0", meanDb: -29, talkMs: 3_000 },
        { key: "1:1", meanDb: -24, talkMs: 1_500 },
      ],
      { meKeys: [a.meKey!, b.meKey!], meKeySource: "enrolled" },
    );
    expect(r.speakers.filter((s) => s.role === "me").map((s) => s.key)).toEqual(["0:1", "1:0"]);
    expect(r.meSource).toBe("enrolled");
    expect(r.meUncertain).toBe(false);
  });

  it("只有第 0 段命中时，第 1 段退回响度而不是全判成别人", () => {
    const r = assignSpeakerRoles(
      [
        { key: "0:0", meanDb: -24, talkMs: 1_500 },
        { key: "0:1", meanDb: -29, talkMs: 3_000 },
        { key: "1:0", meanDb: -22, talkMs: 3_000 },
        { key: "1:1", meanDb: -30, talkMs: 1_500 },
      ],
      { meKeys: ["0:1"], meKeySource: "enrolled" },
    );
    expect(r.speakers.filter((s) => s.role === "me").map((s) => s.key)).toEqual(["0:1", "1:0"]);
  });

  it("注册 key 不在实际说话人里时静默退回响度", () => {
    const r = assignSpeakerRoles(
      [
        { key: "0:0", meanDb: -24, talkMs: 3_000 },
        { key: "0:1", meanDb: -30, talkMs: 3_000 },
      ],
      { meKeys: ["0:9"], meKeySource: "enrolled" },
    );
    expect(r.speakers.find((s) => s.role === "me")?.key).toBe("0:0");
    expect(r.meSource).toBe("loudness");
  });
});
