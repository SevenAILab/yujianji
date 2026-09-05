import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { LOCAL_ONLY } from "@/lib/app-mode";

export const metadata: Metadata = {
  title: "遇见集 · 遇见世界，收藏第一次",
  description: "一个记得你所有第一次的旅行博物志。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{LOCAL_ONLY ? <div className="local-mode-banner">离线本地版 · 数据留在本机 · 云端 AI 已关闭</div> : null}{children}</body>
    </html>
  );
}
