import { NextResponse } from "next/server";
import { jobErrorResponse, jsonError, memoGuard } from "@/lib/memo/server/http";
import { saveChunk } from "@/lib/memo/server/jobs";
import { isValidUploadId, sweepStale } from "@/lib/memo/server/tmp-store";
import { CHUNK_BYTES } from "@/lib/memo/upload-plan";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 400 块 × 3MB ≈ 1.2GB，远超 2 小时手机录音 */
const MAX_CHUNKS = 400;

export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;

  const uploadId = request.headers.get("x-upload-id");
  const index = Number(request.headers.get("x-chunk-index"));
  const total = Number(request.headers.get("x-chunk-total"));
  if (!isValidUploadId(uploadId)) return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || !Number.isInteger(index) || index < 0 || index >= total) {
    return jsonError(400, "INVALID_REQUEST", "分块序号不正确");
  }
  if (Number(request.headers.get("content-length") ?? 0) > CHUNK_BYTES) {
    return jsonError(413, "CHUNK_TOO_LARGE", "分块超过 3MB");
  }

  void sweepStale().catch(() => undefined);
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > CHUNK_BYTES) return jsonError(413, "CHUNK_TOO_LARGE", "分块超过 3MB");
    if (bytes.byteLength === 0) return jsonError(400, "INVALID_REQUEST", "分块是空的");
    return NextResponse.json(await saveChunk({ uploadId, deviceId: gate.deviceId, index, total, bytes }));
  } catch (error) {
    return jobErrorResponse(error, "memo_chunk_error");
  }
}
