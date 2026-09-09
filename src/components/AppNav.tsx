"use client";

import { Camera, Globe2, NotebookText, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <Link className={pathname.startsWith("/journeys") ? "active" : ""} href="/journeys">
        <NotebookText size={19} strokeWidth={1.8} />
        旅途
      </Link>
      <Link className={pathname === "/" ? "active" : ""} href="/">
        <Globe2 size={20} strokeWidth={1.8} />
        地图
      </Link>
      <Link className={pathname.startsWith("/devices") ? "active" : ""} href="/devices">
        <Camera size={19} strokeWidth={1.8} />
        设备
      </Link>
      <Link className={pathname.startsWith("/me") ? "active" : ""} href="/me">
        <User size={19} strokeWidth={1.8} />
        我的
      </Link>
    </nav>
  );
}
