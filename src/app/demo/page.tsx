"use client";

// 路演扫码入口：/demo。先由根布局的同意弹层征得同意，同意后自动载入示例手帐，直接进旅途。
// 已经载入过（或已是最新版示例）就不重复写；自己的记录一条不动。
// 想落到别的页面：/demo?to=/universe
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { isConsentCurrent, readConsent } from "@/lib/consent";
import { loadDemoData } from "@/lib/db";

const ALLOWED = new Set(["/journeys", "/universe", "/"]);

export default function DemoEntryPage() {
  return (
    <Suspense fallback={null}>
      <DemoEntry />
    </Suspense>
  );
}

function DemoEntry() {
  const router = useRouter();
  const to = useSearchParams().get("to") ?? "/journeys";
  const target = ALLOWED.has(to) ? to : "/journeys";
  // 同意弹层写的是 db.meta，这里订阅它：用户点完「开始使用」就接着往下走
  const consent = useLiveQuery(() => readConsent(), [], undefined);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current || consent === undefined || !isConsentCurrent(consent)) return;
    started.current = true;
    void loadDemoData()
      .then(() => router.replace(target))
      .catch(() => {
        started.current = false;
        setError("示例没载入成功，检查一下网络再刷新试试。");
      });
  }, [consent, router, target]);

  return (
    <main className="app-shell">
      <div className="phone-page" style={{ paddingTop: 120, textAlign: "center" }}>
        <p style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 800, margin: 0 }}>遇见集</p>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 10 }}>{error || "正在打开示例：英国 5 天的旅行，和深圳的两个周末…"}</p>
      </div>
    </main>
  );
}
