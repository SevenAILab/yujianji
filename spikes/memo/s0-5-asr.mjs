// S0 第 5、6 项：ffmpeg 转单声道 → 百炼临时存储 → Fun-ASR 分说话人 → 结果。记录每一段耗时。
// 用法：node s0-5-asr.mjs fixtures/demo-1min.m4a [fun-asr] [host]
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const input = process.argv[2] ?? "fixtures/demo-1min.m4a";
const model = process.argv[3] ?? "fun-asr";
const host = process.argv[4] ?? "https://dashscope.aliyuncs.com";
const timings = {};
const t = (label, t0) => { timings[label] = Date.now() - t0; };
const auth = { Authorization: `Bearer ${env.apiKey}` };

const T0 = Date.now();
mkdirSync("results/asr", { recursive: true });
const base = path.basename(input, path.extname(input));
const mono = `results/asr/${base}-16k.m4a`;
const pcm = `results/asr/${base}-8k.pcm`;
let t0 = Date.now();
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", mono]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", "8000", "-f", "s16le", pcm]);
t("ffmpeg", t0);

t0 = Date.now();
const policyRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, { headers: auth });
const policyJson = await policyRes.json();
t("getPolicy", t0);
if (!policyRes.ok) { console.log("policy failed", policyRes.status, JSON.stringify(policyJson).slice(0, 300)); process.exit(1); }
const p = policyJson.data;
console.log("policy fields", Object.keys(p), "expire", p.expire_in_seconds, "maxMB", p.max_file_size_mb);

t0 = Date.now();
const key = `${p.upload_dir}/${Date.now()}-${path.basename(mono)}`;
const form = new FormData();
form.append("OSSAccessKeyId", p.oss_access_key_id);
form.append("Signature", p.signature);
form.append("policy", p.policy);
form.append("x-oss-object-acl", p.x_oss_object_acl);
form.append("x-oss-forbid-overwrite", p.x_oss_forbid_overwrite);
form.append("key", key);
form.append("success_action_status", "200");
form.append("file", new Blob([readFileSync(mono)], { type: "audio/mp4" }), path.basename(mono));
const ossRes = await fetch(p.upload_host, { method: "POST", body: form });
t("ossUpload", t0);
if (!ossRes.ok) { console.log("oss failed", ossRes.status, (await ossRes.text()).slice(0, 300)); process.exit(1); }
const ossUrl = `oss://${key}`;
console.log("uploaded", ossUrl.replace(/\/[^/]+$/, "/<file>"), statSync(mono).size, "bytes");

t0 = Date.now();
const submitRes = await fetch(`${host}/api/v1/services/audio/asr/transcription`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json", "X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable" },
  body: JSON.stringify({ model, input: { file_urls: [ossUrl] }, parameters: { channel_id: [0], diarization_enabled: true, language_hints: ["zh", "en"] } }),
});
const submitJson = await submitRes.json();
t("submit", t0);
if (!submitRes.ok) { console.log("submit failed", submitRes.status, JSON.stringify(submitJson).slice(0, 400)); process.exit(1); }
const taskId = submitJson.output.task_id;
console.log("task", taskId, submitJson.output.task_status);

t0 = Date.now();
let status;
let polls = 0;
while (true) {
  await new Promise((r) => setTimeout(r, 1000));
  polls += 1;
  const r = await fetch(`${host}/api/v1/tasks/${taskId}`, { headers: auth });
  status = await r.json();
  const s = status.output?.task_status;
  if (s === "SUCCEEDED" || s === "FAILED" || s === "UNKNOWN") break;
  if (Date.now() - t0 > 300_000) { console.log("poll timeout"); break; }
}
t("asrWait", t0);
console.log("final", status.output?.task_status, "polls", polls, JSON.stringify(status.output?.results?.map((x) => ({ subtask: x.subtask_status, code: x.code, message: x.message }))));
if (status.output?.task_status !== "SUCCEEDED") { console.log(JSON.stringify(status).slice(0, 800)); process.exit(1); }

t0 = Date.now();
const result = status.output.results[0];
const tr = await (await fetch(result.transcription_url)).json();
t("fetchResult", t0);
timings.total = Date.now() - T0;
writeFileSync(`results/asr/${base}-${model}.json`, JSON.stringify(tr, null, 2));

const sentences = tr.transcripts?.[0]?.sentences ?? [];
console.log("properties", JSON.stringify(tr.properties));
console.log("sentence keys", Object.keys(sentences[0] ?? {}));

// 响度：8kHz s16le，对每个说话人的句子时段算 RMS dB，按时长加权
const buf = readFileSync(pcm);
const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
const bySpeaker = new Map();
for (const s of sentences) {
  const a = Math.floor((s.begin_time / 1000) * 8000);
  const b = Math.min(samples.length, Math.floor((s.end_time / 1000) * 8000));
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += samples[i] * samples[i];
  const n = Math.max(1, b - a);
  const db = 20 * Math.log10(Math.sqrt(sum / n) / 32768 + 1e-9);
  const cur = bySpeaker.get(s.speaker_id) ?? { weighted: 0, ms: 0 };
  cur.weighted += db * (s.end_time - s.begin_time);
  cur.ms += s.end_time - s.begin_time;
  bySpeaker.set(s.speaker_id, cur);
  console.log(`  [${s.speaker_id}] ${s.begin_time}-${s.end_time} ${db.toFixed(1)}dB ${s.text}`);
}
console.log("speakers", JSON.stringify([...bySpeaker].map(([id, v]) => ({ id, meanDb: +(v.weighted / v.ms).toFixed(1), talkMs: v.ms }))));
console.log("TIMINGS", JSON.stringify(timings));
