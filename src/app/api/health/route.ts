import { NextResponse } from "next/server";
import { KV_BACKEND, LIMITS, readTodayUsage } from "@/lib/api-guard";
import { kvHealthy } from "@/lib/kv";
import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 线上到底跑的什么模型，一条 curl 就能确认 —— 这是黑客松那次
 * 「两个域名配的什么没人说得清」换来的接口。
 *
 * 只回配置事实，绝不打模型（那要花钱），也绝不回 key。
 */
export async function GET() {
  const [kvOk, usage] = await Promise.all([kvHealthy(), readTodayUsage()]);

  return NextResponse.json(
    {
      ok: true,
      version: APP_VERSION,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || process.env.BUILD_COMMIT || null,
      model: {
        vision: process.env.VISION_MODEL ?? "qwen3-vl-plus",
        omni: process.env.OMNI_MODEL ?? "qwen3.5-omni-plus",
        fallbacks: (process.env.VISION_FALLBACK_MODELS ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        baseUrlHost:
          hostOf(process.env.DASHSCOPE_BASE_URL) ?? "dashscope.aliyuncs.com",
        apiKeyConfigured: Boolean(process.env.DASHSCOPE_API_KEY),
        jsonMode: process.env.LLM_JSON_MODE === "true",
      },
      quota: {
        backend: KV_BACKEND,
        healthy: kvOk,
        usedToday: usage,
        dailyBudget: LIMITS.dailyBudget(),
        deviceHourly: LIMITS.deviceHourly(),
        deviceDaily: LIMITS.deviceDaily(),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
