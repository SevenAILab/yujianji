import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { callVision } from "../src/lib/llm";

dotenv.config({ path: ".env.local" });

const fixturePath = path.join(process.cwd(), "scripts", "fixtures", "test.jpg");
if (!fs.existsSync(fixturePath)) {
  throw new Error(`缺少测试图片: ${fixturePath}`);
}

const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(fixturePath).toString("base64")}`;
const prompt = `请用 JSON 返回照片里最明显的主体：
{"unrecognized":false,"name":"主体名称"}
不要输出 JSON 之外的文字。`;

async function main() {
  let failures = 0;
  for (const model of ["qwen3-vl-plus", "qwen-vl-max"]) {
    const variants =
      model === "qwen3-vl-plus"
        ? [
            { name: "thinking_off_json_off", enableThinking: false, jsonMode: false },
            { name: "thinking_on_json_off", enableThinking: true, jsonMode: false },
            { name: "thinking_off_json_on", enableThinking: false, jsonMode: true },
          ]
        : [
            { name: "thinking_off_json_off", enableThinking: false, jsonMode: false },
            { name: "thinking_off_json_on", enableThinking: false, jsonMode: true },
          ];
    for (const variant of variants) {
      const startedAt = Date.now();
      try {
        const result = await callVision({
          imageDataUrl: dataUrl,
          systemPrompt: "你是一个视觉识别测试助手。",
          userText: prompt,
          model,
          enableThinking: variant.enableThinking,
          jsonMode: variant.jsonMode,
        });
        console.log(JSON.stringify({
          model,
          variant: variant.name,
          elapsedMs: Date.now() - startedAt,
          responseLength: result.length,
        }));
      } catch (error) {
        failures += 1;
        console.error(JSON.stringify({
          model,
          variant: variant.name,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }
  if (failures > 0) process.exitCode = 1;
}

void main();
