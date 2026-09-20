// 遇见手记 eval（spec §4.12）
// npm run eval:memo -- --suite judge|write|quotes|backfill [--model <id>] [--provider dashscope|eval] [--limit N] [--concurrency 3] [--only <caseId>]
// 结果写入 eval/memo/results/<日期>-<suite>-<model>.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: true });

type Speaker = "me" | "other" | "uncertain";

interface Args {
  suite: "judge" | "write" | "quotes" | "backfill";
  model?: string;
  provider: "dashscope" | "eval";
  limit?: number;
  concurrency: number;
  only?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const suite = (get("suite") ?? "judge") as Args["suite"];
  if (!["judge", "write", "quotes", "backfill"].includes(suite)) throw new Error(`未知 suite：${suite}`);
  return {
    suite,
    model: get("model"),
    provider: (get("provider") ?? "dashscope") as Args["provider"],
    limit: get("limit") ? Number(get("limit")) : undefined,
    concurrency: Number(get("concurrency") ?? 3),
    only: get("only"),
  };
}

function loadCases<T extends { id: string }>(suite: string, args: Args): T[] {
  const dir = path.join("eval", "memo", suite);
  const cases = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      const data = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as T | T[];
      return Array.isArray(data) ? data : [data];
    })
    .filter((c) => !args.only || c.id === args.only);
  return args.limit ? cases.slice(0, args.limit) : cases;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function save(args: Args, modelLabel: string, report: unknown): string {
  mkdirSync(path.join("eval", "memo", "results"), { recursive: true });
  const file = path.join("eval", "memo", "results", `${localDate()}-${args.suite}-${modelLabel.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

async function seedRules() {
  const { seedProfile } = await import("../src/lib/memo/learning");
  return seedProfile(new Date().toISOString()).rules.map(({ id, kind, text, origin, locked }) => ({ id, kind, text, origin, locked }));
}

// ── judge ───────────────────────────────────────────────────────────────

interface JudgeCase {
  id: string;
  tags?: string[];
  place?: string;
  window: { utterances: { id: string; speaker: Speaker; text: string; offsetMs?: number }[] };
  expected: { utteranceIds: string[]; decision: "keep" | "fold" | "drop"; category: string }[];
  note?: string;
}

const RANK = { keep: 2, fold: 1, drop: 0 } as const;

async function runJudge(args: Args) {
  const { judgeWindow } = await import("../src/lib/memo/service/judge");
  const { modelIdFor } = await import("../src/lib/agent/provider");
  const rules = await seedRules();
  const cases = loadCases<JudgeCase>("judge", args);
  const modelLabel = args.model ?? modelIdFor("agent");
  console.log(`judge：${cases.length} 条，模型 ${modelLabel}`);

  const results = await pool(cases, args.concurrency, async (c) => {
    const key = (id: string) => `${c.id}:${id}`;
    const request = {
      runId: `eval_${c.id}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_:.-]/g, ""),
      mode: "session" as const,
      session: { id: `eval_${c.id}`, kind: "in_app" as const, startedAt: "2026-09-22T06:00:00.000Z", timeZone: "Europe/London", place: c.place ?? "伦敦" },
      window: {
        id: `${c.id}:w0`,
        utterances: c.window.utterances.map((u, i) => ({ id: key(u.id), offsetMs: u.offsetMs ?? i * 4_000, speaker: u.speaker, text: u.text })),
      },
      sessionNotes: "",
      profile: { version: 1, rules },
      learnedExamples: [],
      todayKept: [],
      memoryIndex: [],
    };
    try {
      const res = await judgeWindow(request, { modelOverride: { modelId: args.model, provider: args.provider } });
      const entries = c.expected.map((e) => {
        const ids = e.utteranceIds.map(key);
        const hits = res.moments.filter((m) => m.sourceUtteranceIds.some((id) => ids.includes(id))).sort((a, b) => RANK[b.decision] - RANK[a.decision] || b.salience - a.salience);
        const got = hits[0]?.decision ?? "drop";
        return { expected: e.decision, expectedCategory: e.category, got, gotCategory: hits[0]?.category ?? "(未交)", correct: got === e.decision, categoryCorrect: (hits[0]?.category ?? "") === e.category, omitted: hits.length === 0 };
      });
      const expectedKeepIds = new Set(c.expected.filter((e) => e.decision === "keep").flatMap((e) => e.utteranceIds.map(key)));
      const falseKeeps = res.moments.filter((m) => m.decision === "keep" && !m.sourceUtteranceIds.some((id) => expectedKeepIds.has(id))).length;
      const tools = res.trace.steps.filter((s) => s.kind === "tool").map((s) => s.name);
      console.log(`${entries.every((e) => e.correct) ? "✓" : "✗"} ${c.id} ${entries.map((e) => `${e.expected}→${e.got}`).join(" ")} ${(res.trace.ms / 1000).toFixed(1)}s${tools.length ? ` 工具:${tools.join(",")}` : ""}`);
      return { id: c.id, tags: c.tags ?? [], entries, falseKeeps, ms: res.trace.ms, cost: res.trace.costYuan, outcome: res.trace.outcome, tools, moments: res.moments.map((m) => ({ ids: m.sourceUtteranceIds, decision: m.decision, category: m.category, salience: m.salience, trigger: m.trigger, why: m.why, guardNotes: m.guardNotes })), steps: res.trace.steps };
    } catch (error) {
      const e = error as { code?: string; message?: string; trace?: { ms: number; costYuan: number; steps: unknown[] } };
      console.log(`! ${c.id} ${e.code ?? "ERROR"} ${e.message ?? ""}`);
      return { id: c.id, tags: c.tags ?? [], entries: c.expected.map((x) => ({ expected: x.decision, expectedCategory: x.category, got: "error", gotCategory: "", correct: false, categoryCorrect: false, omitted: true })), falseKeeps: 0, ms: e.trace?.ms ?? 0, cost: e.trace?.costYuan ?? 0, outcome: "failed", tools: [], error: `${e.code}: ${e.message}`, moments: [], steps: e.trace?.steps ?? [] };
    }
  });

  const entries = results.flatMap((r) => r.entries.map((e) => ({ ...e, tags: r.tags, id: r.id })));
  const correct = entries.filter((e) => e.correct).length;
  const tp = entries.filter((e) => e.expected === "keep" && e.got === "keep").length;
  const fn = entries.filter((e) => e.expected === "keep" && e.got !== "keep").length;
  const fp = results.reduce((sum, r) => sum + r.falseKeeps, 0);
  const tags = [...new Set(entries.flatMap((e) => e.tags))].sort();
  const byTag = Object.fromEntries(tags.map((tag) => {
    const list = entries.filter((e) => e.tags.includes(tag));
    return [tag, { total: list.length, correct: list.filter((e) => e.correct).length }];
  }));
  const ms = results.map((r) => r.ms).filter(Boolean);
  const summary = {
    suite: "judge",
    model: modelLabel,
    cases: results.length,
    entries: entries.length,
    accuracy: correct / entries.length,
    categoryAccuracy: entries.filter((e) => e.categoryCorrect).length / entries.length,
    keepPrecision: tp + fp ? tp / (tp + fp) : null,
    keepRecall: tp + fn ? tp / (tp + fn) : null,
    byTag,
    errors: results.filter((r) => "error" in r && r.error).length,
    degraded: results.filter((r) => r.outcome === "degraded").length,
    toolCalls: results.reduce<Record<string, number>>((acc, r) => {
      for (const t of r.tools) acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {}),
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    costYuan: results.reduce((sum, r) => sum + r.cost, 0),
    wrong: entries.filter((e) => !e.correct).map((e) => `${e.id}: 期望 ${e.expected}/${e.expectedCategory}，得到 ${e.got}/${e.gotCategory}`),
  };
  return { modelLabel, report: { summary, results } };
}

// ── write ───────────────────────────────────────────────────────────────

interface WriteCase {
  id: string;
  trap?: boolean;
  moment: { heading: string; myQuotes: string[]; othersParaphrase?: string; trigger?: string };
  mustNotContain: string[];
  mustKeepKeywords: string[];
}

async function runWrite(args: Args) {
  const { writeDiary } = await import("../src/lib/memo/service/write");
  const { SUBLIMATION_BLACKLIST } = await import("../src/lib/memo/fidelity");
  const { modelIdFor } = await import("../src/lib/agent/provider");
  const rules = await seedRules();
  const cases = loadCases<WriteCase>("write", args);
  const modelLabel = args.model ?? modelIdFor("writer");
  console.log(`write：${cases.length} 条，模型 ${modelLabel}`);

  const results = await pool(cases, args.concurrency, async (c) => {
    const source = [...c.moment.myQuotes, c.moment.othersParaphrase ?? ""].join("\n");
    try {
      const res = await writeDiary(
        {
          runId: `eval_w_${c.id}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_:.-]/g, ""),
          dayKey: "2026-09-22",
          moments: [{ id: `m_${c.id}`, heading: c.moment.heading, myQuotes: c.moment.myQuotes, othersParaphrase: c.moment.othersParaphrase, trigger: c.moment.trigger ?? "", salience: 0.8 }],
          profile: { version: 1, rules },
        },
        { writerModelId: args.model },
      );
      const p = res.paragraphs[0];
      const text = p.text;
      const violations = c.mustNotContain.filter((w) => text.includes(w) && !source.includes(w));
      // 关键词写成 "灯下|灯光下" 表示任一出现即可（同一个意思的不同写法）
      const missing = c.mustKeepKeywords.filter((k) => !k.split("|").some((alt) => text.toLowerCase().includes(alt.toLowerCase())));
      const blacklisted = SUBLIMATION_BLACKLIST.filter((w) => text.includes(w) && !source.includes(w));
      const intercepted = p.degraded || p.retries > 0 || res.trace.steps.some((s) => s.name === "fidelity_issue");
      const pass = !violations.length && !missing.length && !blacklisted.length;
      console.log(`${pass ? "✓" : "✗"} ${c.id}${c.trap ? "（陷阱）" : ""} ${p.degraded ? "[未润色]" : p.verified ? "[自查通过]" : ""}${p.retries ? "[重写过]" : ""} ${text.slice(0, 60)}`);
      return { id: c.id, trap: Boolean(c.trap), pass, violations, missing, blacklisted, intercepted, degraded: p.degraded, verified: p.verified, retries: p.retries, text, quotes: res.quotes, ms: res.trace.ms, cost: res.trace.costYuan, steps: res.trace.steps };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      console.log(`! ${c.id} ${e.code ?? "ERROR"} ${e.message ?? ""}`);
      return { id: c.id, trap: Boolean(c.trap), pass: false, violations: [], missing: [], blacklisted: [], intercepted: false, degraded: false, verified: false, retries: 0, text: "", quotes: [], ms: 0, cost: 0, steps: [], error: `${e.code}: ${e.message}` };
    }
  });
  const ms = results.map((r) => r.ms).filter(Boolean);
  const summary = {
    suite: "write",
    model: modelLabel,
    cases: results.length,
    pass: results.filter((r) => r.pass).length,
    trapsPass: `${results.filter((r) => r.trap && r.pass).length}/${results.filter((r) => r.trap).length}`,
    intercepted: results.filter((r) => r.intercepted).length,
    degraded: results.filter((r) => r.degraded).length,
    errors: results.filter((r) => "error" in r && r.error).length,
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    costYuan: results.reduce((sum, r) => sum + r.cost, 0),
    failed: results.filter((r) => !r.pass).map((r) => `${r.id}: 违禁 ${r.violations.join("/") || "-"}，缺关键词 ${r.missing.join("/") || "-"}，升华 ${r.blacklisted.join("/") || "-"}`),
  };
  return { modelLabel, report: { summary, results } };
}

// ── quotes（纯代码校验，不调模型）──────────────────────────────────────────

interface QuoteCase {
  id: string;
  trap?: boolean;
  sources: { momentId: string; salience: number; myQuotes: string[] }[];
  candidates: { momentId: string; text: string; expectPass: boolean }[];
  note?: string;
}

async function runQuotes(args: Args) {
  const { verifyQuotes } = await import("../src/lib/memo/quotes");
  const cases = loadCases<QuoteCase>("quotes", args);
  const results = cases.map((c) => {
    const r = verifyQuotes(c.candidates.map(({ momentId, text }) => ({ momentId, text })), c.sources);
    const outcomes = c.candidates.map((cand, i) => {
      const rejected = r.rejected.find((x) => x.text === cand.text && x.momentId === cand.momentId);
      const passed = !rejected && !r.fallbackUsed;
      return { text: cand.text, expectPass: cand.expectPass, passed, reason: rejected?.reason ?? null, ok: passed === cand.expectPass, index: i };
    });
    const ok = outcomes.every((o) => o.ok);
    console.log(`${ok ? "✓" : "✗"} ${c.id}${c.trap ? "（陷阱）" : ""} ${outcomes.map((o) => `${o.expectPass ? "应过" : "应拦"}:${o.passed ? "过" : `拦(${o.reason})`}`).join(" ")}`);
    return { id: c.id, trap: Boolean(c.trap), ok, outcomes, shown: r.quotes };
  });
  const summary = {
    suite: "quotes",
    cases: results.length,
    ok: results.filter((r) => r.ok).length,
    trapsBlocked: `${results.filter((r) => r.trap && r.ok).length}/${results.filter((r) => r.trap).length}`,
  };
  return { modelLabel: "code", report: { summary, results } };
}

// ── backfill ────────────────────────────────────────────────────────────

interface BackfillCase {
  id: string;
  memoryIndex: string[];
  window: { utterances: { id: string; speaker: Speaker; text: string }[] };
  expectedDayKey: string;
  expectedPlace: string;
}

async function runBackfill(args: Args) {
  const { judgeWindow } = await import("../src/lib/memo/service/judge");
  const { modelIdFor } = await import("../src/lib/agent/provider");
  const rules = await seedRules();
  const cases = loadCases<BackfillCase>("backfill", args);
  const modelLabel = args.model ?? modelIdFor("agent");
  const results = await pool(cases, args.concurrency, async (c) => {
    try {
      const res = await judgeWindow(
        {
          runId: `eval_b_${c.id}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_:.-]/g, ""),
          mode: "backfill",
          session: { id: `eval_${c.id}`, kind: "backfill", startedAt: "2026-09-28T12:00:00.000Z", timeZone: "Asia/Shanghai" },
          window: { id: `${c.id}:w0`, utterances: c.window.utterances.map((u, i) => ({ id: `${c.id}:${u.id}`, offsetMs: i * 4_000, speaker: u.speaker, text: u.text })) },
          sessionNotes: "",
          profile: { version: 1, rules },
          learnedExamples: [],
          todayKept: [],
          memoryIndex: c.memoryIndex,
        },
        { modelOverride: { modelId: args.model, provider: args.provider } },
      );
      const best = res.moments.filter((m) => m.decision !== "drop").sort((a, b) => b.salience - a.salience)[0];
      const target = best?.backfillTarget;
      const hit = Boolean(best && !best.needsPlacePick && target?.dayKey === c.expectedDayKey && (target.place ?? "").includes(c.expectedPlace));
      const candidateHit = Boolean(best?.needsPlacePick && best.backfillCandidates?.some((x) => x.dayKey === c.expectedDayKey && (x.place ?? "").includes(c.expectedPlace)));
      const recalled = res.trace.steps.some((s) => s.kind === "tool" && s.name === "recall_memory");
      console.log(`${hit ? "✓" : candidateHit ? "~" : "✗"} ${c.id} → ${target ? `${target.dayKey} ${target.place ?? ""} (${target.confidence})` : "无目标"}${best?.needsPlacePick ? " [让用户选]" : ""}${recalled ? " 翻了记忆" : " 没翻记忆"}`);
      return { id: c.id, hit, candidateHit, recalled, target, needsPlacePick: best?.needsPlacePick ?? false, candidates: best?.backfillCandidates ?? [], ms: res.trace.ms, cost: res.trace.costYuan, steps: res.trace.steps };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      console.log(`! ${c.id} ${e.code} ${e.message}`);
      return { id: c.id, hit: false, candidateHit: false, recalled: false, target: undefined, needsPlacePick: false, candidates: [], ms: 0, cost: 0, steps: [], error: `${e.code}: ${e.message}` };
    }
  });
  const summary = {
    suite: "backfill",
    model: modelLabel,
    cases: results.length,
    hits: results.filter((r) => r.hit).length,
    lowConfidenceWithCandidate: results.filter((r) => r.candidateHit).length,
    recalledMemory: results.filter((r) => r.recalled).length,
    p50Ms: percentile(results.map((r) => r.ms).filter(Boolean), 0.5),
    costYuan: results.reduce((sum, r) => sum + r.cost, 0),
  };
  return { modelLabel, report: { summary, results } };
}

async function main() {
  const args = parseArgs();
  const started = Date.now();
  const run = { judge: runJudge, write: runWrite, quotes: runQuotes, backfill: runBackfill }[args.suite];
  const { modelLabel, report } = await run(args);
  const file = save(args, modelLabel, { ...report, ranAt: new Date().toISOString(), wallMs: Date.now() - started, provider: args.provider });
  console.log("\nSUMMARY", JSON.stringify((report as { summary: unknown }).summary, null, 2));
  console.log("saved", file);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
