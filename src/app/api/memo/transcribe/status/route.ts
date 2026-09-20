import { NextResponse, type NextRequest } from "next/server";
import { recordSpend } from "@/lib/agent/budget";
import { jobErrorResponse, jsonError, memoGuard } from "@/lib/memo/server/http";
import { transcribeStatus } from "@/lib/memo/server/jobs";
import { isValidUploadId } from "@/lib/memo/server/tmp-store";

export const runtime = "nodejs";
export const maxDuration = 60;

function list(value: string | null): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items.slice(0, 20) : undefined;
}

/**
 * 成功后删除该上传的服务端临时目录（D11）。
 * taskIds / offsets 由前端带上：服务端 state 已被清理时（结果取过、超过 2 小时），仍能凭任务号重新取结果，只是算不出响度。
 */
export async function GET(request: NextRequest) {
  const gate = await memoGuard(request, "light");
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const uploadId = params.get("uploadId");
  if (!isValidUploadId(uploadId)) return jsonError(400, "BAD_UPLOAD_ID", "上传标识不正确");
  const taskIds = list(params.get("taskIds"));
  if (taskIds?.some((id) => !/^[A-Za-z0-9-]{8,80}$/.test(id))) return jsonError(400, "INVALID_REQUEST", "任务号格式不正确");
  const offsets = list(params.get("offsets"))?.map(Number).filter((n) => Number.isFinite(n) && n >= 0);

  try {
    const result = await transcribeStatus({ uploadId, deviceId: gate.deviceId, taskIds, offsets });
    if (result.status === "succeeded" && result.asrCostYuan) recordSpend(result.asrCostYuan);
    if (result.status === "failed") return NextResponse.json({ status: "failed", code: result.error?.code, error: result.error?.message });
    return NextResponse.json(result);
  } catch (error) {
    return jobErrorResponse(error, "memo_transcribe_status_error");
  }
}
