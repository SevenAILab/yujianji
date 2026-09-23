// 取压缩好的模型（GLB 二进制）。浏览器拿到后存进本机，服务器上的文件 2 小时后删除。
import { NextResponse } from "next/server";
import { readJob, readModel } from "@/lib/model3d/server";

export const runtime = "nodejs";

const DEVICE_ID = /^dev_[A-Za-z0-9_-]{16,40}$/;

export async function POST(request: Request) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!DEVICE_ID.test(deviceId)) return NextResponse.json({ code: "DEVICE_REQUIRED", error: "缺少有效的设备标识" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { taskId?: unknown } | null;
  const taskId = typeof body?.taskId === "string" ? body.taskId : "";
  const job = await readJob(taskId);
  if (!job || job.deviceId !== deviceId || job.state !== "ready") return NextResponse.json({ code: "NOT_READY", error: "模型还没好" }, { status: 404 });
  const bytes = await readModel(taskId);
  if (!bytes) return NextResponse.json({ code: "EXPIRED", error: "模型文件已过期" }, { status: 410 });
  return new Response(bytes as BodyInit, { headers: { "content-type": "model/gltf-binary", "cache-control": "private, no-store" } });
}
