// 查建模进度（不花钱）。只返回本设备提交的任务。
import { NextResponse } from "next/server";
import { readJob, refreshJob, sweepModels } from "@/lib/model3d/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEVICE_ID = /^dev_[A-Za-z0-9_-]{16,40}$/;

export async function POST(request: Request) {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!DEVICE_ID.test(deviceId)) return NextResponse.json({ code: "DEVICE_REQUIRED", error: "缺少有效的设备标识" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { taskIds?: unknown } | null;
  const taskIds = Array.isArray(body?.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string").slice(0, 12) : [];
  void sweepModels();
  const jobs = await Promise.all(
    taskIds.map(async (taskId) => {
      const job = await readJob(taskId);
      if (!job || job.deviceId !== deviceId) return { taskId, state: "failed", error: "没找到这个建模任务" };
      try {
        const next = await refreshJob(job);
        return { taskId, state: next.state, progress: next.progress, error: next.error };
      } catch {
        return { taskId, state: job.state, progress: job.progress }; // 查询失败不算失败，下次再查
      }
    }),
  );
  return NextResponse.json({ jobs });
}
