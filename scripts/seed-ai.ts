import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { callVision } from "../src/lib/llm";
import { buildSeedUserText, SEED_SYSTEM_PROMPT } from "../src/lib/prompt";
import { parseRecognizeResult } from "../src/lib/recognize";
import type { Item, RecognizedAi } from "../src/lib/types";

dotenv.config({ path: ".env.local" });

const root = process.cwd();
const seedPath = path.join(root, "data", "seed.json");
const publicSeedPath = path.join(root, "public", "seed-data.json");
const items = JSON.parse(fs.readFileSync(seedPath, "utf8")) as Item[];

function imageDataUrl(item: Item): string {
  const filePath = path.join(root, "public", item.photo.replace(/^\//, ""));
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function main() {
  for (const [index, item] of items.entries()) {
    if (!fs.existsSync(path.join(root, "public", item.photo.replace(/^\//, "")))) {
      throw new Error(`缺少照片: ${item.photo}`);
    }

    process.stdout.write(`[${index + 1}/${items.length}] ${item.id} ... `);
    const raw = await callVision({
      imageDataUrl: imageDataUrl(item),
      systemPrompt: SEED_SYSTEM_PROMPT,
      userText: buildSeedUserText(item.name, item.place, item.userNote),
    });
    const result = parseRecognizeResult(raw, []);

    if (result.unrecognized) {
      throw new Error(`${item.id} 无法识别，停止写入`);
    }

    const ai: RecognizedAi = {
      cognition: result.cognition,
      fun: result.fun,
      luck: result.luck,
      question: result.question,
      verdict: "first",
      relatedItemId: null,
      memorySentence: result.memorySentence,
    };
    item.ai = ai;
    console.log("ok");
  }

  const output = `${JSON.stringify(items, null, 2)}\n`;
  fs.writeFileSync(seedPath, output);
  fs.writeFileSync(publicSeedPath, output);
  console.log(`已生成 ${items.length} 条 seed AI 字段，请人工校对后提交。`);
}

void main();
