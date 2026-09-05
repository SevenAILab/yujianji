"use client";

import { Compass, Route, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <Link className={pathname === "/" ? "active" : ""} href="/">
        <Compass size={17} strokeWidth={2.3} />
        地图
      </Link>
      <Link className={pathname.startsWith("/journeys") ? "active" : ""} href="/journeys">
        <Route size={17} strokeWidth={2.3} />
        旅程
      </Link>
      <Link className={pathname.startsWith("/firsts") ? "active" : ""} href="/firsts">
        <Sparkles size={16} strokeWidth={2.3} />
        第一次
      </Link>
    </nav>
  );
}
