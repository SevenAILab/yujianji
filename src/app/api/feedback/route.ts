import { NextResponse } from "next/server";
import { z } from "zod";
import { incr, KvUnavailableError } from "@/lib/kv";

export const runtime = "nodejs";

const feedbackSchema = z.object({
  kind: z.enum(["idea", "bug", "report"]),
  message: z.string().trim().min(4).max(2000),
  /** 举报时可带上被举报记录的名称，帮助定位；不接收照片。 */
  subject: z.string().trim().max(120).optional(),
  contact: z.string().trim().max(120).optional(),
  path: z.string().trim().max(200).optional(),
});

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,40}$/;

export async function POST(request: Request) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return NextResponse.json(
      { error: "缺少有效的设备标识", code: "DEVICE_REQUIRED" },
      { status: 401 },
    );
  }

  // 反馈不花模型的钱，所以配额比识别宽松得多，只挡刷屏。
  try {
    const count = await incr(`feedback:${deviceId}:${new Date().toISOString().slice(0, 13)}`, 3_700);
    if (count > 10) {
      return NextResponse.json(
        { error: "提交太频繁了，过一会儿再试。", code: "RATE_LIMITED" },
        { status: 429 },
      );
    }
  } catch (error) {
    // 限流后端挂了不该挡住用户反馈 —— 反馈本身不烧钱。
    if (!(error instanceof KvUnavailableError)) throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式不对", code: "INVALID_REQUEST" }, { status: 400 });
  }

  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "内容太短或太长，写 4–2000 字。", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  // 当前没有数据库，反馈落在服务端日志里（Vercel / nginx 都能看）。
  // 举报单独提到 error 级，便于在日志里一眼筛出来并优先处理。
  const record = {
    event: parsed.data.kind === "report" ? "user_report" : "user_feedback",
    kind: parsed.data.kind,
    deviceId,
    subject: parsed.data.subject ?? null,
    contact: parsed.data.contact ?? null,
    path: parsed.data.path ?? null,
    message: parsed.data.message,
    at: new Date().toISOString(),
  };
  if (parsed.data.kind === "report") console.error(JSON.stringify(record));
  else console.info(JSON.stringify(record));

  return NextResponse.json({ ok: true });
}
