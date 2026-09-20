// 从主项目 .env.local 读配置，不打印密钥。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const file = path.resolve(here, "../../.env.local");
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^"|"$/g, "");
    // 项目 .env.local 优先：避免 shell 里残留的同名变量遮蔽（踩坑账本：env 遮蔽）
    process.env[m[1]] = value;
  }
  return {
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
  };
}

export function describeEnv(env) {
  return { baseURL: env.baseURL, hasKey: Boolean(env.apiKey), keyPrefix: env.apiKey?.slice(0, 3) };
}
