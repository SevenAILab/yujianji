import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { ConsentGate } from "@/components/ConsentGate";
import { RecorderProvider } from "@/components/memo/RecorderProvider";
import { ModelJobRunner } from "@/components/universe/ModelJobRunner";

export const metadata: Metadata = {
  title: "遇见集 · 遇见世界，收藏第一次",
  description: "一个记得你所有第一次的旅行博物志。照片只存在你自己的设备里。",
  applicationName: "遇见集",
  appleWebApp: {
    capable: true,
    title: "遇见集",
    statusBarStyle: "default",
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2f6f6a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {LOCAL_ONLY ? (
          <div className="local-mode-banner">离线本地版 · 数据留在本机 · 云端 AI 已关闭</div>
        ) : null}
        {/* 录音器挂在这里：切页面不断，才能录着音去首页拍照 */}
        <RecorderProvider>{children}</RecorderProvider>
        <ConsentGate />
        {/* 刚拍的第一次在后台建成 3D，建好存本机，精神图景里就会出现 */}
        <ModelJobRunner />
      </body>
    </html>
  );
}
