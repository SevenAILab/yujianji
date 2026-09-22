import { mkdir, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { jobErrorResponse, jsonError, memoGuard } from "@/lib/memo/server/http";
import { enrollSourcePath, isValidUploadId, uploadDir } from "@/lib/memo/server/tmp-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 声纹注册音频上限：8 秒的 16k 单声道，2MB 绰绰有余 */
const ENROLL_MAX_BYTES = 2 * 1024 * 1024;
const ENROLL_MAX_MS = 30_000;

/**
 * 上传声纹注册音频（「随便说点什么，让我认识一下」录的那一小段）。
 * 服务端会把它转码后拼到每一个 ASR 分段前面，注册段落在哪个说话人上，那个就是"我"。
 */
export async function POST(request: Request) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;

  const uploadId = request.headers.get("x-upload-id");
  const enrollMs = Number(request.headers.get("x-enroll-ms"));
  if (!isValidUploadId(uploadId)) return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  if (!Number.isInteger(enrollMs) || enrollMs <= 0 || enrollMs > ENROLL_MAX_MS) {
    return jsonError(400, "INVALID_REQUEST", "注册音频时长不正确");
  }
  if (Number(request.headers.get("content-length") ?? 0) > ENROLL_MAX_BYTES) {
    return jsonError(413, "CHUNK_TOO_LARGE", "注册音频太大");
  }

  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return jsonError(400, "INVALID_REQUEST", "注册音频是空的");
    if (bytes.byteLength > ENROLL_MAX_BYTES) return jsonError(413, "CHUNK_TOO_LARGE", "注册音频太大");
    await mkdir(uploadDir(uploadId), { recursive: true });
    await writeFile(enrollSourcePath(uploadId), bytes);
    return NextResponse.json({ ok: true, enrollMs });
  } catch (error) {
    return jobErrorResponse(error, "memo_enroll_error");
  }
}
