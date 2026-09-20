// 遇见手记端到端（真实前端代码 + 真实服务端路由 + 真实百炼）：
// 在 Node 里用 fake-indexeddb 跑 orchestrator，打本机 dev server 的 /api/memo/*。
// 录音用 spikes/memo/fixtures 里 macOS say 合成的对话（不含任何真实录音）。
// 用法：npx tsx scripts/memo-e2e-client.ts [http://localhost:3100] [fixture.m4a]
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3100";
const fixture = process.argv[3] ?? "spikes/memo/fixtures/demo-1min.m4a";
process.env.NEXT_PUBLIC_API_BASE = base;

async function main() {
  await import("fake-indexeddb/auto");
  const { db } = await import("../src/lib/db");
  const { createSession, finalizeAudio, runPipeline } = await import("../src/lib/memo/client/orchestrator");
  const { readMvhdFromBlob } = await import("../src/lib/memo/mvhd");
  const { memoApi, MemoApiError } = await import("../src/lib/memo/client/api");
  const { deleteMoment, restoreMoment, copyFeedback, runReflect } = await import("../src/lib/memo/client/learn");

  const bytes = readFileSync(fixture);
  const blob = new Blob([bytes], { type: "audio/mp4" });
  const info = await readMvhdFromBlob(blob);
  console.log("fixture", path.basename(fixture), `${(bytes.length / 1024).toFixed(0)}KB`, info);

  const t0 = Date.now();
  const session = await createSession({
    kind: "import",
    startedAt: info?.creationTime ?? new Date().toISOString(),
    durationSec: Math.round(info?.durationSec ?? 0),
    startedAtSource: info?.creationTime ? "file_metadata" : "user",
    place: { name: "伦敦 · 海德公园", source: "manual", confidence: "high", locked: true },
    timeZone: "Europe/London",
  });
  await finalizeAudio(session.id, blob, "audio/mp4");

  let last = "";
  const final = await runPipeline(session.id, {
    onProgress: (p) => {
      const line = `${p.status}: ${p.message}`;
      if (line !== last) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
      last = line;
    },
  });
  const wallMs = Date.now() - t0;
  console.log("\nfinal status", final.status, final.error ?? "");
  console.log("timings", JSON.stringify(final.timings?.map((t) => ({ stage: t.stage, s: ((t.ms ?? 0) / 1000).toFixed(1), over: t.overBudget }))));
  console.log("speakers", JSON.stringify(final.speakers), final.meSource, "uncertain:", final.meUncertain);

  const utterances = await db.utterances.where("sessionId").equals(session.id).sortBy("index");
  for (const u of utterances) console.log(`  [${u.speaker}] ${u.text}`);
  const windows = await db.memoWindows.where("sessionId").equals(session.id).toArray();
  for (const w of windows) console.log("window", w.id, JSON.stringify(w.triage), JSON.stringify(w.judge));
  const moments = await db.moments.where("sessionId").equals(session.id).toArray();
  for (const m of moments) console.log(`moment ${m.decision} ${m.category} s=${m.salience} ${m.dayKey} ${m.place?.name} ｜${m.trigger} ｜${m.why} ｜我：${m.myQuotes.join(" / ")}`);

  const days = [...new Set(moments.map((m) => m.dayKey))];
  for (const d of days) {
    const diary = await db.diaryDays.get(d);
    console.log(`\n== diary ${d}: ${diary?.title} (${diary?.status}) ==`);
    for (const q of diary?.quotes ?? []) console.log("  金句:", q.text);
    for (const p of diary?.paragraphs ?? []) console.log(`  ${p.heading}${p.degraded ? "（未润色）" : ""}\n  ${p.text}`);
    console.log("  folded:", diary?.foldedMomentIds.length);
  }

  const traces = await db.agentTraces.toArray();
  const cost = traces.reduce((sum, t) => sum + t.costYuan, 0);
  console.log(`\ntraces ${traces.length}：${traces.map((t) => `${t.scope}(${t.outcome},${(t.ms / 1000).toFixed(1)}s)`).join(" ")}`);
  console.log(`total cost ¥${cost.toFixed(4)}；stop→diary wall time ${(wallMs / 1000).toFixed(1)}s`);

  // 幂等：已完成的会话再跑一次直接返回；服务端临时目录已删除
  const again = await runPipeline(session.id);
  console.log("\nre-run pipeline →", again.status, "(无新请求)");
  const candidates = [path.join(os.tmpdir(), "yujianji-memo", final.uploadId ?? "none"), path.join("/tmp/yujianji-memo", final.uploadId ?? "none")];
  console.log("server tmp dir removed:", candidates.every((dir) => !existsSync(dir)), candidates);
  try {
    await memoApi.transcribe(final.uploadId!);
    console.log("transcribe after cleanup: unexpected success");
  } catch (error) {
    console.log("transcribe after cleanup →", error instanceof MemoApiError ? error.code : error);
  }
  const localAudio = await db.memoAudio.get(session.id);
  console.log("local audio deleted:", !localAudio, "chunks left:", await db.memoChunks.where("sessionId").equals(session.id).count());

  // 反馈闭环：删除、捞回、复制，攒够 3 次后反思
  const kept = moments.filter((m) => m.decision === "keep");
  const folded = moments.filter((m) => m.decision === "fold");
  if (kept[0]) await deleteMoment(kept[0].id);
  if (folded[0]) await restoreMoment(folded[0].id);
  if (kept[1]) await copyFeedback(kept[1].id, "paragraph");
  const events = await db.feedbackEvents.toArray();
  console.log("\nfeedback events", events.map((e) => e.type));
  if (events.length) {
    const reflect = await runReflect();
    console.log("reflect →", JSON.stringify({ changed: reflect.changed, version: reflect.profile.version, summary: reflect.summary, rejected: reflect.rejected }));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
