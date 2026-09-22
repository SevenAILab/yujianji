// 合成测试录音：用 macOS say 生成两个人的中英混说对话，模拟 iPhone 语音备忘录（双声道 AAC 48k，带录制时间）。
// "我"的声音更响（手机在我身上），同伴音量低 8dB。不使用任何真实录音，避免未审内容外传。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const ME = "Eddy (中文（中国大陆）)";
const FRIEND = "Tingting (中文（中国大陆）)";

const scripts = {
  // 1 分钟左右：演示 A 的形状 —— 功能对话 + 一句感慨
  "demo-1min": {
    creationTime: "2026-09-15T06:20:00Z",
    lines: [
      [FRIEND, "你看那边，好多人躺在草坪上。", 0.6],
      [ME, "麻烦问一下，洗手间在哪边？", 0.8],
      [FRIEND, "左边，过了那个小桥就是。", 1.0],
      [ME, "我突然觉得我们平时太着急了，他们就这么躺着晒太阳，一点都不觉得休息是件可耻的事。在国内我下班了还要做账号，根本不敢停下来。", 0.8],
      [FRIEND, "他们四点就下班了，下了班是真的不回消息。", 0.7],
      [ME, "真的假的？", 1.0],
      [ME, "排了一个小时队，腿都要断了。", 0.6],
    ],
  },
  // 约 3 分钟：含停顿 ≥ 8 秒，测窗口切分；含工作讨论与新场合感受（第 4 条边界）
  "expo-3min": {
    creationTime: "2026-09-21T02:05:00Z",
    lines: [
      [ME, "接口明天几点对一下？我这边上传那块还没联调。", 0.8],
      [FRIEND, "上午十点吧，你把 schema 发我。", 0.8],
      [ME, "好，我今晚发。", 9.0],
      [ME, "哇，第一次见到这么多 coser，感觉像走进了动画片，大家都特别放得开。", 0.8],
      [FRIEND, "那个是原神的角色，做得好精细。", 0.7],
      [ME, "我小时候也特别想穿成这样出门，但是那时候总觉得会被人笑，现在看他们这么自在，有点羡慕。", 1.0],
      [FRIEND, "这个展馆是去年新建的，据说用了很多回收材料。", 0.8],
      [ME, "导游刚说这个屋顶是用回收的塑料瓶做的，现在还在用，挺酷的。", 9.0],
      [ME, "这个咖啡多少钱？给我来一杯拿铁，谢谢。", 0.8],
      [FRIEND, "我跟他分手，就是因为他从来不陪我出来玩。", 0.8],
      [ME, "嗯嗯。", 1.0],
      [ME, "这个冰淇淋是我吃过最好吃的，有一点海盐的味道，so good。", 1.0],
    ],
  },
  // 配图专用：句子真的在讲 Pictures/第一次遇见照片 里的那几张，
  // 三张白崖照片互为干扰项，另有一段反思故意没有对应照片，用来验"留白"。
  "cliff-2min": {
    creationTime: "2026-09-04T09:00:00Z",
    lines: [
      [ME, "不好意思问一下，去崖顶那条路是从这边上吗？", 0.8],
      [FRIEND, "对，沿着栅栏一直走就到了。", 1.2],
      [ME, "我第一次看到这么白的悬崖，整面崖壁白得不像真的，像有人拿刀切下来一样。", 9.0],
      [ME, "崖边上那座灯塔，孤零零一个白塔杵在那儿，风大得我帽子都要飞了。", 9.0],
      [FRIEND, "这片崖壁是白垩纪的沉积岩，每年会往后退好几厘米。", 0.9],
      [ME, "真的假的？", 9.0],
      [ME, "港口那些鸽子一点都不怕人，你走过去它都不动，就站在缆绳上看海。", 9.0],
      [ME, "走了一天我突然想，我可能不需要把每个景点都打卡完。以前出门我总怕漏掉什么，今天在崖边坐了半小时，什么都没干，反而是最舒服的一段。", 1.0],
    ],
  },
};

const name = process.argv[2] ?? "demo-1min";
const spec = scripts[name];
if (!spec) throw new Error(`unknown script ${name}`);

const outDir = path.resolve("fixtures");
const work = path.join(outDir, `${name}-parts`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const concatList = [];
spec.lines.forEach(([voice, text, pause], index) => {
  const aiff = path.join(work, `${index}.aiff`);
  execFileSync("say", ["-v", voice, "-r", "190", "-o", aiff, text]);
  const wav = path.join(work, `${index}.wav`);
  const gain = voice === ME ? "0dB" : "-8dB";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-af", `volume=${gain},apad=pad_dur=${pause}`, "-ar", "48000", "-ac", "1", wav]);
  concatList.push(`file '${wav}'`);
});
const listFile = path.join(work, "list.txt");
writeFileSync(listFile, concatList.join("\n"));
const out = path.join(outDir, `${name}.m4a`);
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
  "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "124k",
  "-metadata", `creation_time=${spec.creationTime}`,
  out,
]);
const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=channels,sample_rate:format_tags=creation_time", "-of", "json", out]).toString();
console.log(out, probe.replace(/\s+/g, " "));
