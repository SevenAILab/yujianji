"use client";

import { ArrowLeft, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { ItemCard } from "@/components/ItemCard";
import { db, ensureSeeded } from "@/lib/db";
import type { Item } from "@/lib/types";

export default function FirstsPage() {
  const router = useRouter();
  const [seedReady, setSeedReady] = useState(false);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").reverse().toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );

  useEffect(() => {
    let active = true;
    void ensureSeeded()
      .catch(() => undefined)
      .finally(() => {
        if (active) setSeedReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const firsts = items.filter((item) => item.ai?.verdict === "first");

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={() => router.push("/")} aria-label="返回地图">
            <ArrowLeft size={18} />
          </button>
          <div className="brand-lockup">
            <h1>我的第一次</h1>
            <span><Sparkles size={13} /></span>
          </div>
          <span className="muted">{firsts.length} 次</span>
        </header>

        <p className="privacy-note" style={{ marginTop: 16 }}>
          不是所有遇见都要成为第一次，但每一次都值得被记住。
        </p>

        <div className="content-stack">
          {firsts.length > 0 ? (
            <div className="item-grid">
              {firsts.map((item) => <ItemCard item={item} key={item.id} />)}
            </div>
          ) : (
            <div className="surface empty-state">还没有第一次。去遇见一件东西吧。</div>
          )}
        </div>
      </div>
      <AppNav />
    </main>
  );
}
