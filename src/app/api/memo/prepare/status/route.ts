import { NextResponse, type NextRequest } from "next/server";
import { jobErrorResponse, jsonError, memoGuard } from "@/lib/memo/server/http";
import { prepareStatus } from "@/lib/memo/server/jobs";
import { isValidUploadId } from "@/lib/memo/server/tmp-store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const uploadId = request.nextUrl.searchParams.get("uploadId");
  if (!isValidUploadId(uploadId)) return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  try {
    const result = await prepareStatus(uploadId, gate.deviceId);
    if (result.status === "failed") {
      // 失败码直接放进 code，前端按码显示可重试
      return NextResponse.json({ status: "failed", code: result.error?.code, error: result.error?.message });
    }
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error, "memo_prepare_status_error");
  }
}
