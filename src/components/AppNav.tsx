"use client";

import { Globe2, NotebookText, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 底栏只留三个：旅途（每日手帐）/ 地图（首页，拍摄·录音·导入都在这里）/ 我的。
 * 「手记」并进首页的录音按钮和旅途页，「设备」并进「我的」；那些页面仍可直达。
 */
export function AppNav() {
  const pathname = usePathname();
  const onJourneys = pathname.startsWith("/journeys") || pathname.startsWith("/memo/day");
  // 注意 "/memo".startsWith("/me") 也是真的——以前「手记」和「我的」会同时高亮
  const onMe = pathname === "/me" || pathname.startsWith("/me/") || pathname.startsWith("/devices") || pathname === "/memo/me" || pathname.startsWith("/memo/enroll");
  return (
    <nav className="bottom-nav bottom-nav--home-style" aria-label="主导航">
      <Link className={onJourneys ? "active" : ""} href="/journeys">
        <NotebookText size={19} strokeWidth={1.8} />
        旅途
      </Link>
      <Link className={pathname === "/" || pathname.startsWith("/universe") ? "active" : ""} href="/">
        <Globe2 size={20} strokeWidth={1.8} />
        地图
      </Link>
      <Link className={onMe ? "active" : ""} href="/me">
        <User size={19} strokeWidth={1.8} />
        我的
      </Link>
    </nav>
  );
}
