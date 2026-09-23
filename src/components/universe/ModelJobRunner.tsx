"use client";

// 后台建模跑腿：App 开着就每 20 秒看一眼——刚拍的初见自动提交建模，建好的模型取回来存本机。
// 页面在后台时不跑；没有要等的也不发请求。
import { useEffect } from "react";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { submitMissing, syncModelJobs } from "@/lib/model3d/client";

const INTERVAL_MS = 20_000;

export function ModelJobRunner() {
  useEffect(() => {
    if (LOCAL_ONLY) return;
    let running = false;
    const tick = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await submitMissing({ auto: true, limit: 2 });
        await syncModelJobs();
      } catch {
        // 网络抖动：下一轮再来
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
