import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { NextResponse } from "next/server";
import { dailyBudgetYuan, spentTodayYuan } from "@/lib/agent/budget";
import { inflightCount } from "@/lib/agent/inflight";
import { memoBaseUrl, memoKeySource, modelIdFor, structuredOutputsEnabled } from "@/lib/agent/provider";
import { asrBaseUrl, asrModel } from "@/lib/memo/server/bailian";
import { ffmpegAvailable } from "@/lib/memo/server/ffmpeg";
import { tmpRoot } from "@/lib/memo/server/tmp-store";

export const runtime = "nodejs";

/** 部署验收用（spec S0 第 4 项）：ffmpeg、临时目录、模型路由。不返回密钥和任何用户数据。 */
export async function GET() {
  let tmpWritable = false;
  try {
    await mkdir(tmpRoot(), { recursive: true });
    await access(tmpRoot(), constants.W_OK);
    tmpWritable = true;
  } catch {
    tmpWritable = false;
  }
  return NextResponse.json({
    ffmpeg: await ffmpegAvailable(),
    tmpWritable,
    apiKey: memoKeySource(),
    modelHost: (() => { try { return new URL(memoBaseUrl()).host; } catch { return "invalid"; } })(),
    asr: { model: asrModel(), host: new URL(asrBaseUrl()).host },
    models: {
      triage: modelIdFor("triage"),
      agent: modelIdFor("agent"),
      writer: modelIdFor("writer"),
      verifier: modelIdFor("verifier"),
      reflect: modelIdFor("reflect"),
    },
    structuredOutputs: structuredOutputsEnabled(),
    searchEnabled: process.env.MEMO_ENABLE_SEARCH !== "false",
    budget: { spentTodayYuan: Math.round(spentTodayYuan() * 1000) / 1000, limitYuan: dailyBudgetYuan() },
    inflight: inflightCount(),
  });
}
