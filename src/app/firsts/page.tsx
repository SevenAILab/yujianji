"use client";

import { ArrowLeft, CalendarDays, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { ItemCard } from "@/components/ItemCard";
import { db, ensureSeeded } from "@/lib/db";
import { toHistoryEntry } from "@/lib/history";
import type { Item } from "@/lib/types";

export default function FirstsPage() {
  const router = useRouter();
  const [seedReady, setSeedReady] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
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
  const latestDate = useMemo(
    () => items[0]?.date.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    [items],
  );

  function openSummary() {
    const latest = new Date(latestDate);
    const start = new Date(latest);
    start.setDate(start.getDate() - 120);
    setStartDate(start.toISOString().slice(0, 10));
    setEndDate(latestDate);
    setSummaryText("");
    setSummaryError("");
    setSummaryOpen(true);
  }

  async function summarize() {
    setSummaryLoading(true);
    setSummaryError("");
    try {
      const selected = items.filter((item) => {
        const date = item.date.slice(0, 10);
        return (!startDate || date >= startDate) && (!endDate || date <= endDate);
      });
      if (!selected.length) {
        setSummaryError("这段时间还没有可总结的第一次。");
        return;
      }
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          history: selected.map(toHistoryEntry),
        }),
      });
      const payload = (await response.json()) as { summary?: string; error?: string };
      if (!response.ok || !payload.summary) {
        throw new Error(payload.error ?? "旅程总结暂时不可用");
      }
      setSummaryText(payload.summary);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "旅程总结暂时不可用");
    } finally {
      setSummaryLoading(false);
    }
  }

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
            <button className="summary-trigger" onClick={openSummary}>
              <CalendarDays size={17} />
              总结最近一趟旅程
              <span>P2</span>
            </button>
          ) : null}
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
      {summaryOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setSummaryOpen(false)}>
          <section
            className="summary-modal surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="summary-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="summary-modal-head">
              <div>
                <p className="eyebrow">一段时间的遇见</p>
                <h2 id="summary-title">总结最近一趟旅程</h2>
              </div>
              <button className="icon-action" onClick={() => setSummaryOpen(false)} aria-label="关闭总结">
                <X size={17} />
              </button>
            </div>
            <div className="summary-range">
              <label>
                从
                <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <span>到</span>
              <label>
                <span className="sr-only">结束日期</span>
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </label>
            </div>
            <button className="primary-action" onClick={() => void summarize()} disabled={summaryLoading}>
              <Sparkles size={17} />
              {summaryLoading ? "正在翻阅记录…" : "写一段总结"}
            </button>
            {summaryError ? <div className="error-box">{summaryError}</div> : null}
            {summaryText ? (
              <div className="summary-result">
                <p>{summaryText}</p>
                <small>仅根据你选中的遇见生成；文字会在总结期间临时发送给百炼，AI 生成，未经核实。</small>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
