import { NextResponse, type NextRequest } from "next/server";
import { jobErrorResponse, jsonError, memoGuard } from "@/lib/memo/server/http";
import { uploadStatus } from "@/lib/memo/server/jobs";
import { isValidUploadId } from "@/lib/memo/server/tmp-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 续传用：服务端已经收到了哪些块（刷新页面后不信本地计数，以服务端为准） */
export async function GET(request: NextRequest) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const uploadId = request.nextUrl.searchParams.get("uploadId");
  if (!isValidUploadId(uploadId)) return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  try {
    return NextResponse.json(await uploadStatus(uploadId, gate.deviceId));
  } catch (error) {
    return jobErrorResponse(error, "memo_upload_status_error");
  }
}
