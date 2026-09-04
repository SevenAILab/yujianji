"use client";

import {
  ArrowLeft,
  Check,
  CircleAlert,
  MapPin,
  MessageCircle,
  Trash2,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { ShareCard } from "@/components/ShareCard";
import { db, ensureSeeded } from "@/lib/db";
import { toHistoryEntry } from "@/lib/history";
import { CATEGORY_LABELS } from "@/lib/types";
import type { Item } from "@/lib/types";
import { formatDate, formatMonth } from "@/lib/format";
import { recognizeResultSchema } from "@/lib/schema";

export default function ItemPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [seedReady, setSeedReady] = useState(false);
  const item = useLiveQuery(
    () => (seedReady ? db.items.get(id) : Promise.resolve(undefined as Item | undefined)),
    [id, seedReady],
  );
  const related = useLiveQuery(
    () => (item?.ai?.relatedItemId ? db.items.get(item.ai.relatedItemId) : undefined),
    [item?.ai?.relatedItemId],
  );
  const [answer, setAnswer] = useState("");
  const [savedAnswer, setSavedAnswer] = useState(false);
  const [actionError, setActionError] = useState("");
  const [redeveloping, setRedeveloping] = useState(false);

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

  useEffect(() => {
    if (item?.answer) setAnswer(item.answer);
  }, [item?.answer]);

  if (item === undefined) {
    return (
      <main className="app-shell">
        <div className="phone-page">
          <div className="surface empty-state">正在打开这件遇见…</div>
        </div>
      </main>
    );
  }

  if (!item) {
    return (
      <main className="app-shell">
        <div className="phone-page">
          <button className="icon-action" onClick={() => router.push("/")} aria-label="返回地图">
            <ArrowLeft size={18} />
          </button>
          <div className="surface empty-state">没有找到这件藏品。</div>
        </div>
      </main>
    );
  }

  const currentItem = item;

  async function saveAnswer() {
    if (!answer.trim()) return;
    try {
      await db.items.update(currentItem.id, { answer: answer.trim() });
      setSavedAnswer(true);
      setActionError("");
    } catch {
      setActionError("回答暂时没有保存成功，请检查浏览器存储空间后重试。");
    }
  }

  async function deleteItem() {
    if (!window.confirm("确定要删除这件遇见吗？")) return;
    try {
      await db.items.delete(currentItem.id);
      router.push("/");
    } catch {
      setActionError("删除暂时没有完成，请重试。");
    }
  }

  async function redevelop() {
    if (redeveloping) return;
    setRedeveloping(true);
    setActionError("");
    try {
      const history = (await db.items.orderBy("date").toArray())
        .filter((entry) => entry.id !== currentItem.id)
        .map(toHistoryEntry);
      const response = await fetch("/api/recognize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: currentItem.photo,
          userNote: currentItem.userNote,
          history,
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const failed = payload as { error?: string };
        throw new Error(failed.error ?? "重新显影失败，请重试");
      }
      const result = recognizeResultSchema.parse(payload);
      if (result.unrecognized) {
        throw new Error("这张照片仍然没有足够依据，先保留为未显影。");
      }
      await db.items.update(currentItem.id, {
        name: result.name,
        nameEn: result.nameEn ?? undefined,
        category: result.category,
        ai: {
          cognition: result.cognition,
          fun: result.fun,
          luck: result.luck,
          question: result.question,
          verdict: result.verdict,
          relatedItemId: result.relatedItemId,
          memorySentence: result.memorySentence,
        },
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "重新显影失败，请重试");
    } finally {
      setRedeveloping(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={() => router.back()} aria-label="返回">
            <ArrowLeft size={18} />
          </button>
          <span className="muted">{formatMonth(item.date)}</span>
          <button className="icon-action" onClick={() => void deleteItem()} aria-label="删除藏品">
            <Trash2 size={17} />
          </button>
        </header>

        <div className="hero-photo">
          <img src={item.photo} alt={item.name} />
        </div>

        <div className="detail-title">
          <div>
            <h1>{item.name}</h1>
            <div className="detail-meta">
              <span><MapPin size={13} /> {item.place}</span>
              <span>{formatDate(item.date)}</span>
              <span>{CATEGORY_LABELS[item.category]}</span>
            </div>
          </div>
          {item.isSeed ? <span className="badge">示例数据</span> : null}
        </div>

        <div className="content-stack">
          {item.ai ? (
            <section className={`verdict-card ${item.ai.verdict === "reunion" ? "reunion" : ""}`}>
              <p className="eyebrow">{item.ai.verdict === "reunion" ? "这不是第一次" : "一件新的遇见"}</p>
              <h2>{item.ai.verdict === "reunion" ? "重逢" : "初见"}</h2>
              <p>{item.ai.memorySentence}</p>
              {item.ai.verdict === "reunion" && related ? (
                <div className="compare-grid">
                  <figure>
                    <img src={item.photo} alt={`现在的${item.name}`} />
                    <figcaption>现在 · {item.place}</figcaption>
                  </figure>
                  <figure>
                    <img src={related.photo} alt={`过去的${related.name}`} />
                    <figcaption>那一次 · {related.place} · {formatDate(related.date)}</figcaption>
                  </figure>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="verdict-card">
              <p className="eyebrow">还没有显影</p>
              <h2>先把它留在这里</h2>
              <p>这件遇见没有经过 AI 解读，但照片、地点和你说的话已经保存下来了。</p>
              <button className="secondary-action" style={{ marginTop: 14 }} onClick={() => void redevelop()} disabled={redeveloping}>
                {redeveloping ? "正在重新显影…" : "重新显影"}
              </button>
            </section>
          )}

          {item.ai ? (
            <section className="content-card surface museum-section">
              <p className="eyebrow">AI 博物志</p>
              <div className="museum-section">
                <h2>它是什么</h2>
                <p>{item.ai.cognition}</p>
              </div>
              <div className="museum-section">
                <h2>有趣在哪</h2>
                <p>{item.ai.fun}</p>
              </div>
              <div className="museum-section">
                <h2>你有多幸运</h2>
                <p>{item.ai.luck.text}</p>
                <div className={item.ai.luck.confidence === "low" ? "basis low-confidence" : "basis"}>
                  依据：{item.ai.luck.basis}
                </div>
                <div className="basis">
                  <CircleAlert size={12} /> AI 生成，未经核实
                </div>
              </div>
            </section>
          ) : null}

          <section className="content-card surface">
            <p className="eyebrow">我的记录</p>
            <p className="museum-section">
              {item.userNote || "那一刻，你还没有留下话。"}
            </p>
            {item.locationSource !== "gps" ? (
              <div className="status-note warning" style={{ marginTop: 12 }}>
                <MapPin size={14} />
                <span>
                  {item.locationSource === "previous"
                    ? "位置沿用了上一条藏品。"
                    : item.locationSource === "default"
                      ? "未获取定位，暂以深圳记录。"
                      : "地点由你手动填写。"}
                </span>
              </div>
            ) : null}
          </section>

          {item.ai?.question ? (
            <section className="content-card surface">
              <p className="eyebrow"><MessageCircle size={13} /> 它问你</p>
              <div className="question-box">
                <strong>{item.ai.question}</strong>
                <p>{item.answer || "这个回答可以以后再补。"}</p>
                <div className="field">
                  <label htmlFor="answer">回答一句</label>
                  <textarea
                    id="answer"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    placeholder="把当时没说完的话留在这里"
                    maxLength={300}
                  />
                </div>
                <button className="secondary-action" style={{ marginTop: 10 }} onClick={() => void saveAnswer()}>
                  <Check size={16} />
                  {savedAnswer ? "已保存" : "保存回答"}
                </button>
              </div>
            </section>
          ) : null}

          <ShareCard item={item} />
          {actionError ? <div className="error-box">{actionError}</div> : null}

          <div className="action-row">
            <button className="secondary-action" onClick={() => router.push("/")}>
              返回地图
            </button>
            <button className="secondary-action danger-action" onClick={() => void deleteItem()}>
              删除这件
            </button>
          </div>
        </div>
      </div>
      <AppNav />
    </main>
  );
}
