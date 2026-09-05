"use client";

import { Compass, Route, Sparkles, Watch } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <Link className={pathname === "/" ? "active" : ""} href="/"><Compass size={17} strokeWidth={2.3} />地图</Link>
      <Link className={pathname.startsWith("/trip") || pathname.startsWith("/journey") ? "active" : ""} href="/trip"><Route size={16} strokeWidth={2.3} />行程</Link>
      <Link className={pathname.startsWith("/community") ? "active" : ""} href="/community"><Sparkles size={16} strokeWidth={2.3} />社区</Link>
      <Link className={pathname.startsWith("/firsts") ? "active" : ""} href="/firsts"><Sparkles size={16} strokeWidth={2.3} />第一次</Link>
      <Link className={pathname.startsWith("/devices") ? "active" : ""} href="/devices"><Watch size={16} strokeWidth={2.3} />设备</Link>
    </nav>
  );
}
