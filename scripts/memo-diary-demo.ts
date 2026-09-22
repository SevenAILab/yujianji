// 一日手帐验收脚本：录音 → Agent 筛选 → 照片配对 → 今日手记 + 金句。
// 两条路径都要能跑：App 内录音（开头自报家门定我）和导入语音备忘录（退回响度 / 声纹）。
//
// 用法：
//   npx tsx scripts/memo-diary-demo.ts --mode import
//   npx tsx scripts/memo-diary-demo.ts --mode in-app --base http://localhost:3100
//   npx tsx scripts/memo-diary-demo.ts --mode import --fixture spikes/memo/fixtures/expo-3min.m4a --no-photos
//
// --no-photos 时不写入任何照片，用来单独验"定我 + 筛选"这一段。
// 写入的照片是本仓库 public/seed 下的真实图片，但**名字是为了跑通流程编的**，
// 内容和录音无关，所以这个脚本只能验时间/地点对齐，不能验"图文内容是否真的对应"。
// 图文对应必须用 Seven 的真实录音 + 那段时间真拍的照片人工验收。
import { readFileSync, writeFileSync } from "node:fs";

type Mode = "in-app" | "import";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const mode = (arg("mode", "import") as Mode);
const base = arg("base", "https://yujianji.mcs-eco.com")!;
const fixture = arg("fixture", "spikes/memo/fixtures/expo-3min.m4a")!;
const withPhotos = !has("no-photos");
const out = arg("out", "/tmp/diary-demo.json")!;

if (mode !== "in-app" && mode !== "import") {
  console.error(`--mode 只能是 in-app 或 import，收到 ${mode}`);
  process.exit(1);
}
process.env.NEXT_PUBLIC_API_BASE = base;

/** 编造的名字，只为跑通流程；内容和录音无关，见文件头说明 */
const PHOTOS = [
  { offsetSec: -6, name: "会展中心的巨型充气人偶", category: "artifact", photo: "/seed/public-01.jpg" },
  { offsetSec: 18, name: "展台上的机械臂", category: "artifact", photo: "/seed/ceramic-mug.jpg" },
  { offsetSec: 74, name: "排队的人群", category: "landscape", photo: "/seed/whitby-harbor.jpg" },
  { offsetSec: 138, name: "穿动漫服装的参观者", category: "artifact", photo: "/seed/dog.jpg" },
];
const PLACE = "深圳 · 会展中心";
const LAT = 22.5431;
const LNG = 114.0579;
const TZ = "Asia/Shanghai";

async function main() {
  await import("fake-indexeddb/auto");
  const { db } = await import("../src/lib/db");
  const { createSession, finalizeAudio, runPipeline } = await import("../src/lib/memo/client/orchestrator");
  const { readMvhdFromBlob } = await import("../src/lib/memo/mvhd");

  const bytes = readFileSync(fixture);
  const blob = new Blob([bytes], { type: "audio/mp4" });
  const info = await readMvhdFromBlob(blob);
  const startedAt = info?.creationTime ?? new Date().toISOString();
  const startMs = new Date(startedAt).getTime();
  const durationSec = Math.round(info?.durationSec ?? 0);
  console.log(`模式 ${mode}　素材 ${fixture.split("/").pop()}　${durationSec} 秒　开始于 ${startedAt}`);

  if (withPhotos) {
    for (const p of PHOTOS) {
      const at = new Date(startMs + p.offsetSec * 1000).toISOString();
      await db.items.put({
        id: `demo_${p.offsetSec}`,
        name: p.name,
        nameEn: "",
        category: p.category,
        photo: p.photo,
        place: PLACE,
        country: "CHN",
        lat: LAT,
        lng: LNG,
        locationSource: "manual",
        placeSource: "manual",
        date: at,
        dateSource: "exif",
        userNote: "",
        ai: null,
        isSeed: false,
        createdAt: at,
      } as Parameters<typeof db.items.put>[0]);
      console.log(`  照片 ${at.slice(11, 19)}　${p.name}`);
    }
  }

  const session = await createSession({
    kind: mode === "in-app" ? "in_app" : "import",
    startedAt,
    durationSec,
    startedAtSource: "file_metadata",
    place: { name: PLACE, source: "gps", confidence: "high", locked: true },
    timeZone: TZ,
  });
  await finalizeAudio(session.id, blob, "audio/mp4");

  const t0 = Date.now();
  let last = "";
  const final = await runPipeline(session.id, {
    onProgress: (p) => {
      const line = `${p.status}: ${p.message}`;
      if (line !== last) {
        console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
        last = line;
      }
    },
  });
  const wallMs = Date.now() - t0;

  console.log(`\n状态 ${final.status}${final.error ? `　${final.error.message}` : ""}`);
  console.log(`定我　meSource=${final.meSource}　meUncertain=${final.meUncertain}`);
  console.log(`说话人　${JSON.stringify(final.speakers)}`);

  const utterances = await db.utterances.where("sessionId").equals(session.id).sortBy("index");
  const moments = (await db.moments.where("sessionId").equals(session.id).toArray()).sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const days = await db.diaryDays.toArray();
  const items = await db.items.filter((item) => !item.isSeed).toArray();
  const photoById = new Map(items.map((item) => [item.id, item]));

  const counts = { me: 0, other: 0, uncertain: 0 };
  for (const u of utterances) counts[u.speaker] += 1;
  console.log(`\n逐字稿 ${utterances.length} 句　我 ${counts.me} / 别人 ${counts.other} / 拿不准 ${counts.uncertain}`);

  console.log(`\n片段：`);
  for (const m of moments) {
    const photo = m.photoId ? photoById.get(m.photoId) : undefined;
    const tag = photo ? `📷 ${photo.name}` : m.decision === "drop" ? "" : "（留白）";
    console.log(`  ${m.decision.padEnd(4)} ${String(m.category).padEnd(17)} ${m.at.slice(11, 19)} ${String(m.trigger ?? "").slice(0, 20).padEnd(22)} ${tag}`);
  }

  for (const d of days) {
    console.log(`\n== 手记 ${d.dayKey}：${d.title}（${d.status}）==`);
    for (const q of d.quotes) console.log(`   金句　${q.text}`);
    for (const p of d.paragraphs) {
      const m = moments.find((x) => x.id === p.momentId);
      const photo = m?.photoId ? photoById.get(m.photoId) : undefined;
      console.log(`   ${p.heading}${photo ? `　📷 ${photo.name}` : ""}`);
      console.log(`   ${p.text}`);
    }
    if (d.foldedMomentIds.length) console.log(`   折叠区 ${d.foldedMomentIds.length} 条`);
  }

  // 配图自检：只报事实，不替 Agent 做匹配
  const keeps = moments.filter((m) => m.decision !== "drop");
  const withPhoto = keeps.filter((m) => m.photoId);
  const usedPhotoIds = withPhoto.map((m) => m.photoId!);
  const duplicated = usedPhotoIds.filter((id, i) => usedPhotoIds.indexOf(id) !== i);
  const droppedWithPhoto = moments.filter((m) => m.decision === "drop" && m.photoId);
  console.log(`\n配图自检：`);
  console.log(`  留下的片段 ${keeps.length} 条，其中配到图 ${withPhoto.length} 条，留白 ${keeps.length - withPhoto.length} 条`);
  console.log(`  ${duplicated.length ? `❌ 同一张图被复用 ${duplicated.length} 次：${[...new Set(duplicated)].join(", ")}` : "✅ 没有一图多用"}`);
  console.log(`  ${droppedWithPhoto.length ? `❌ 有 ${droppedWithPhoto.length} 条 drop 片段挂了图` : "✅ drop 片段没有挂图"}`);
  console.log(`\n⚠️ 这个脚本只能验时间/地点对齐。图文内容是否真的对应，必须用真实录音 + 真实照片人工验收。`);

  writeFileSync(
    out,
    JSON.stringify(
      {
        mode,
        base,
        fixture,
        wallMs,
        session: {
          id: session.id,
          startedAt,
          place: PLACE,
          status: final.status,
          meSource: final.meSource,
          meUncertain: final.meUncertain,
          speakers: final.speakers,
          timings: final.timings,
        },
        counts,
        utterances,
        moments,
        days,
        items,
      },
      null,
      1,
    ),
  );
  console.log(`\n完整结果 → ${out}　（${(wallMs / 1000).toFixed(1)} 秒）`);
}

main().catch((error) => {
  console.error("FAILED", error);
  process.exit(1);
});
