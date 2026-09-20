// 遇见手记服务端链路冒烟（真实模型）：合成录音的转写结果 → 定我 → 切窗口 → 粗筛 → 判断 → 选段 → 写作 → 金句 → 反思。
// 用法：npx tsx scripts/memo-smoke.ts [asr结果json] [8k pcm]
// 默认用 spikes/memo 里 S0 第 5 项跑出来的合成对话（macOS say 生成，不含任何真实录音）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { speakerLoudness } = await import("../src/lib/memo/loudness");
  const { assignSpeakerRoles } = await import("../src/lib/memo/speaker");
  const { splitWindows } = await import("../src/lib/memo/windows");
  const { triageWindow } = await import("../src/lib/memo/service/triage");
  const { judgeWindow } = await import("../src/lib/memo/service/judge");
  const { writeDiary } = await import("../src/lib/memo/service/write");
  const { reflectProfile } = await import("../src/lib/memo/service/reflect");
  const { selectForDiary } = await import("../src/lib/memo/select");
  const { seedProfile } = await import("../src/lib/memo/learning");
  const { clockIn, dayKeyIn } = await import("../src/lib/memo/time");
  type Moment = import("../src/lib/memo/types").Moment;
  type Utterance = import("../src/lib/memo/types").Utterance;

  const asrFile = process.argv[2] ?? "spikes/memo/results/asr/expo-3min-fun-asr.json";
  const pcmFile = process.argv[3] ?? "spikes/memo/results/asr/expo-3min-8k.pcm";
  const asr = JSON.parse(readFileSync(asrFile, "utf8")) as { transcripts: { sentences: { begin_time: number; end_time: number; text: string; speaker_id: number }[] }[] };
  const sentences = asr.transcripts[0].sentences.map((s) => ({ speakerKey: `0:${s.speaker_id}`, beginMs: s.begin_time, endMs: s.end_time, text: s.text }));
  const buf = readFileSync(pcmFile);
  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.byteLength / 2) * 2));
  const roles = assignSpeakerRoles(speakerLoudness(samples, 8000, sentences));
  const sessionId = "smoke";
  const startedAt = "2026-09-21T02:05:00.000Z";
  const timeZone = "Asia/Shanghai";
  const utterances: Utterance[] = sentences.map((s, index) => ({
    id: `${sessionId}:${index}`,
    sessionId,
    index,
    beginMs: s.beginMs,
    endMs: s.endMs,
    speakerKey: s.speakerKey,
    speaker: roles.speakers.find((x) => x.key === s.speakerKey)?.role ?? "uncertain",
    text: s.text,
    expiresAt: "",
  }));
  console.log("speakers", JSON.stringify(roles));

  const profile = seedProfile(new Date().toISOString());
  const rules = profile.rules.map(({ id, kind, text, origin, locked }) => ({ id, kind, text, origin, locked }));
  const windows = splitWindows(sessionId, utterances);
  const report: Record<string, unknown> = { windows: windows.length, stages: [] as unknown[] };
  const stages = report.stages as { stage: string; ms: number; cost: number; outcome?: string }[];
  const moments: Moment[] = [];
  let sessionNotes = "";

  const t0 = Date.now();
  for (const w of windows) {
    const byId = new Map(utterances.map((u) => [u.id, u]));
    const window = { id: w.id, utterances: w.utteranceIds.map((id) => byId.get(id)!).map((u) => ({ id: u.id, offsetMs: u.beginMs, speaker: u.speaker, text: u.text })) };
    const tri = await triageWindow({ runId: `smoke_tri_${w.index}_${Date.now()}`, window });
    stages.push({ stage: `triage ${w.id}`, ms: tri.trace.ms, cost: tri.trace.costYuan, outcome: `${tri.action}:${tri.reason}` });
    if (tri.action === "skip") continue;
    const judged = await judgeWindow({
      runId: `smoke_judge_${w.index}_${Date.now()}`,
      mode: "session",
      session: { id: sessionId, kind: "import", startedAt, timeZone, place: "深圳 · 会展中心" },
      window,
      sessionNotes,
      profile: { version: 1, rules },
      learnedExamples: [],
      todayKept: moments.filter((m) => m.decision === "keep").map((m) => `${m.trigger}`),
      memoryIndex: ["mem1|2026-09-20|深圳 · 前海|keep|第一次看到海上的日落|想起小时候"],
    });
    sessionNotes = judged.sessionNotes;
    stages.push({ stage: `judge ${w.id}`, ms: judged.trace.ms, cost: judged.trace.costYuan, outcome: judged.trace.outcome });
    console.log(`\n== ${w.id} trace ==`);
    for (const step of judged.trace.steps) console.log(`  [${step.kind}] ${step.name} ${step.ms}ms ${step.summary}${step.reason ? ` ｜${step.reason}` : ""}`);
    for (const m of judged.moments) {
      const first = utterances.find((u) => u.id === m.sourceUtteranceIds[0])!;
      moments.push({
        id: `m_${moments.length}`,
        sessionId,
        windowId: w.id,
        dayKey: dayKeyIn(startedAt, timeZone),
        at: new Date(new Date(startedAt).getTime() + first.beginMs).toISOString(),
        place: { name: "深圳 · 会展中心", source: "manual" },
        decision: m.decision,
        salience: m.salience,
        category: m.category,
        trigger: m.trigger,
        why: m.why,
        myQuotes: m.myQuotes,
        uncertainQuotes: m.uncertainQuotes,
        speakerUncertain: m.speakerUncertain,
        sourceUtteranceIds: m.sourceUtteranceIds,
        othersParaphrase: m.othersParaphrase,
        facts: m.facts,
        user: { copiedCount: 0 },
        runId: judged.trace.runId,
        profileVersion: 1,
        createdAt: new Date().toISOString(),
      });
    }
  }
  const judgeMs = Date.now() - t0;
  console.log("\n== moments ==");
  for (const m of moments) console.log(`  ${m.decision.padEnd(4)} ${m.category.padEnd(16)} s=${m.salience} ${m.trigger} ｜${m.why} ｜我：${m.myQuotes.join(" / ")}${m.facts?.length ? ` ｜AI补充：${m.facts.map((f) => f.fact).join("；")}` : ""}`);

  const selection = selectForDiary(moments);
  const chosen = selection.paragraphIds.map((id) => moments.find((m) => m.id === id)!);
  let writeMs = 0;
  if (chosen.length) {
    const t1 = Date.now();
    const diary = await writeDiary({
      runId: `smoke_write_${Date.now()}`,
      dayKey: chosen[0].dayKey,
      moments: chosen.map((m) => ({ id: m.id, heading: `${clockIn(m.at, timeZone)} · ${m.place?.name ?? "地点未知"}`, myQuotes: m.myQuotes, othersParaphrase: m.othersParaphrase, trigger: m.trigger, salience: m.salience })),
      profile: { version: 1, rules },
    });
    writeMs = Date.now() - t1;
    stages.push({ stage: "write", ms: diary.trace.ms, cost: diary.trace.costYuan, outcome: diary.trace.outcome });
    console.log(`\n== 今日手记：${diary.title} ==`);
    for (const q of diary.quotes) console.log(`  金句：${q.text}`);
    for (const p of diary.paragraphs) console.log(`  ${p.heading}${p.degraded ? "（未润色）" : ""}\n  ${p.text}`);
    console.log("  write trace:");
    for (const step of diary.trace.steps) console.log(`   [${step.kind}] ${step.name} ${step.ms}ms ${step.summary}`);
    report.diary = diary;
  }

  // 反思：假装用户删掉了两段 drop 以外的片段，看代码校验是否工作
  const candidates = moments.filter((m) => m.decision !== "drop").slice(0, 3);
  if (candidates.length >= 2) {
    const refl = await reflectProfile({
      runId: `smoke_reflect_${Date.now()}`,
      profile: { version: 1, rules: profile.rules.map(({ id, kind, text, origin, locked, evidenceMomentIds, active }) => ({ id, kind, text, origin, locked, evidenceMomentIds, active })) },
      events: candidates.slice(0, 2).map((m, i) => ({ id: `ev${i}`, type: "delete" as const, moment: { momentId: m.id, category: m.category, decision: m.decision, trigger: m.trigger, why: m.why, quotes: m.myQuotes.slice(0, 2) } })),
    });
    stages.push({ stage: "reflect", ms: refl.trace.ms, cost: refl.trace.costYuan, outcome: refl.summary });
    console.log("\n== reflect ==", JSON.stringify({ ops: refl.ops, rejected: refl.rejected.map((r) => r.reason), summary: refl.summary }));
  }

  report.moments = moments;
  report.timings = { judgeAllWindowsMs: judgeMs, writeMs };
  report.totalCostYuan = stages.reduce((sum, s) => sum + s.cost, 0);
  console.log("\n== stages ==");
  for (const s of stages) console.log(`  ${s.stage.padEnd(24)} ${String(s.ms).padStart(6)}ms ¥${s.cost.toFixed(5)} ${s.outcome ?? ""}`);
  console.log("total cost ¥", (report.totalCostYuan as number).toFixed(4), "judge ms", judgeMs, "write ms", writeMs);
  mkdirSync("eval/memo/results", { recursive: true });
  const out = path.join("eval/memo/results", `${new Date().toISOString().slice(0, 10)}-smoke-${path.basename(asrFile, ".json")}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("saved", out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
