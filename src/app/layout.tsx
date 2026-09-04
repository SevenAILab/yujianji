import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "遇见集 · 遇见世界，收藏第一次",
  description: "一个记得你所有第一次的旅行博物志。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
