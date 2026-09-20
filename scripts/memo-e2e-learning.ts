// 学习闭环端到端（spec S4 验收的真实模型版本）：
// 一段录音里有 3 句"看排队人群"的感慨被判 keep → 用户删掉其中 2 段 → 反思 → 新规则 → 实验室里同一窗口用新旧画像各跑，重复 3 次看是否稳定。
// 在 Node 里用 fake-indexeddb 跑前端 learn.ts / context.ts，打本机 dev server。
// 用法：npx tsx scripts/memo-e2e-learning.ts [http://localhost:3100]
const base = process.argv[2] ?? "http://localhost:3100";
process.env.NEXT_PUBLIC_API_BASE = base;

async function main() {
  await import("fake-indexeddb/auto");
  const { db } = await import("../src/lib/db");
  const { latestProfile } = await import("../src/lib/memo/client/repo");
  const { deleteMoment, runReflect, labCompare } = await import("../src/lib/memo/client/learn");
  const { splitWindows } = await import("../src/lib/memo/windows");
  type Moment = import("../src/lib/memo/types").Moment;
  type Utterance = import("../src/lib/memo/types").Utterance;

  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
  const profile = await latestProfile();

  // 前一天：两段"看排队人群"的感慨被留下了，用户觉得这类不值得留
  const oldSession = "ses_learn_old";
  await db.memoSessions.put({ id: oldSession, kind: "import", startedAt: "2026-09-22T09:00:00.000Z", endedAt: "2026-09-22T10:00:00.000Z", durationSec: 3600, timeZone: "Europe/London", tzOffsetMin: 60, startedAtSource: "user", status: "ready", createdAt: now, updatedAt: now });
  const oldMoments: Moment[] = [
    { id: "old:m1", sessionId: oldSession, windowId: "old:w0", dayKey: "2026-09-22", at: "2026-09-22T09:10:00.000Z", place: { name: "伦敦 · 国家美术馆", source: "manual" }, decision: "keep", salience: 0.7, category: "observation", trigger: "美术馆门口排长队", why: "你注意到了排队的人群", myQuotes: ["美术馆门口排队的人一直排到街角，大家都好有耐心。"], sourceUtteranceIds: [], user: { copiedCount: 0 }, runId: "seed", profileVersion: 1, createdAt: now },
    { id: "old:m2", sessionId: oldSession, windowId: "old:w0", dayKey: "2026-09-22", at: "2026-09-22T09:40:00.000Z", place: { name: "伦敦 · 伦敦眼", source: "manual" }, decision: "keep", salience: 0.65, category: "observation", trigger: "伦敦眼排队的人", why: "带感受的观察", myQuotes: ["伦敦眼下面排队的队伍绕了三圈，好多人还在排队的时候就开始拍照。"], sourceUtteranceIds: [], user: { copiedCount: 0 }, runId: "seed", profileVersion: 1, createdAt: now },
    { id: "old:m3", sessionId: oldSession, windowId: "old:w0", dayKey: "2026-09-22", at: "2026-09-22T09:55:00.000Z", place: { name: "伦敦 · 圣詹姆斯公园", source: "manual" }, decision: "keep", salience: 0.8, category: "observation", trigger: "天鹅游到脚边", why: "带感受的观察", myQuotes: ["天鹅直接游到我脚边，一点都不怕人。"], sourceUtteranceIds: [], user: { copiedCount: 0 }, runId: "seed", profileVersion: 1, createdAt: now },
  ];
  await db.moments.bulkPut(oldMoments);

  // 今天的一段录音：一句排队观察 + 一句别的感受，用来做实验室对比
  const session = "ses_learn_today";
  await db.memoSessions.put({ id: session, kind: "import", startedAt: "2026-09-23T11:00:00.000Z", endedAt: "2026-09-23T11:05:00.000Z", durationSec: 300, timeZone: "Europe/London", tzOffsetMin: 60, startedAtSource: "user", status: "ready", speakers: [{ key: "0:0", meanDb: -24, talkMs: 1, role: "me" }, { key: "0:1", meanDb: -31, talkMs: 1, role: "other" }], createdAt: now, updatedAt: now });
  const texts: [Utterance["speaker"], string][] = [
    ["me", "大本钟下面排队拍照的人排了好长一条，大家都安安静静地等。"],
    ["other", "我们也排吗？"],
    ["me", "不排了。不过刚才那个修钟的老师傅跟我们挥手，他说他在这修了二十年钟，我觉得好浪漫。"],
  ];
  const utterances: Utterance[] = texts.map(([speaker, text], index) => ({ id: `${session}:${index}`, sessionId: session, index, beginMs: index * 5_000, endMs: index * 5_000 + 4_000, speakerKey: speaker === "me" ? "0:0" : "0:1", speaker, text, expiresAt: expires }));
  await db.utterances.bulkPut(utterances);
  const windows = splitWindows(session, utterances);
  await db.memoWindows.bulkPut(windows);

  console.log("profile v", profile.version, "rules", profile.rules.length);
  await deleteMoment("old:m1");
  await deleteMoment("old:m2");
  console.log("deleted 2 queue observations; events:", (await db.feedbackEvents.toArray()).map((e) => e.type));

  const reflect = await runReflect();
  console.log("reflect →", JSON.stringify({ changed: reflect.changed, version: reflect.profile.version, summary: reflect.summary, opsCount: reflect.opsCount, rejected: reflect.rejected }));
  const after = await latestProfile();
  console.log("new/changed rules:", after.rules.filter((r) => r.origin === "learned").map((r) => `${r.kind}:${r.text}（证据 ${r.evidenceMomentIds.join(",")}）`));

  if (!reflect.changed) {
    console.log("没有学到规则，实验室对比跳过");
    return;
  }
  for (let round = 1; round <= 3; round += 1) {
    const cmp = await labCompare(windows[0].id, { before: profile.version, after: after.version });
    const describe = (run: typeof cmp.before) => run.result?.moments.map((m) => `${m.sourceUtteranceIds.map((id) => id.split(":").pop()).join("+")}:${m.decision}/${m.category}`).join(" ") ?? `失败 ${run.error}`;
    console.log(`round ${round}: v${cmp.before.profileVersion} [${describe(cmp.before)}] → v${cmp.after.profileVersion} [${describe(cmp.after)}] changed=${cmp.changedUtteranceIds.map((id) => id.split(":").pop()).join(",")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
