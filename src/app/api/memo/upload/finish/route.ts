import { NextResponse } from "next/server";
import { z } from "zod";
import { jobErrorResponse, memoGuard, readJson, uploadIdSchema } from "@/lib/memo/server/http";
import { finishUpload } from "@/lib/memo/server/jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  uploadId: uploadIdSchema,
  totalChunks: z.number().int().min(1).max(400),
  mime: z.string().max(80),
});

export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const body = await readJson(request, bodySchema, 2_000);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(await finishUpload({ ...body.data, deviceId: gate.deviceId }));
  } catch (error) {
    return jobErrorResponse(error, "memo_finish_error");
  }
}
