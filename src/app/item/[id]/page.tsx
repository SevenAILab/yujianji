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

const ITEM_LOADING = Symbol("item-loading");

export default function ItemPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [seedReady, setSeedReady] = useState(false);
  const item = useLiveQuery(
    () => (seedReady ? db.items.get(id) : Promise.resolve(undefined as Item | undefined)),
    [id, seedReady],
    ITEM_LOADING,
  );
  const loadedItem = item === ITEM_LOADING ? undefined : item;
  const related = useLiveQuery(
    () =>
      loadedItem?.ai?.relatedItemId
        ? db.items.get(loadedItem.ai.relatedItemId)
        : undefined,
    [loadedItem?.ai?.relatedItemId],
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
    if (loadedItem?.answer) setAnswer(loadedItem.answer);
  }, [loadedItem?.answer]);

  if (item === ITEM_LOADING) {
    return (
      <main className="app-shell">
        <div className="phone-page">
          <div className="surface empty-state">正在打开这件遇见…</div>
        </div>
      </main>
    );
  }

  if (!loadedItem) {
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

  const currentItem = loadedItem;

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
          <span className="muted">{formatMonth(currentItem.date)}</span>
          <button className="icon-action" onClick={() => void deleteItem()} aria-label="删除藏品">
            <Trash2 size={17} />
          </button>
        </header>

        <div className="hero-photo">
          <img src={currentItem.photo} alt={currentItem.name} />
        </div>

        <div className="detail-title">
          <div>
            <h1>{currentItem.name}</h1>
            <div className="detail-meta">
              <span><MapPin size={13} /> {currentItem.place}</span>
              <span>{formatDate(currentItem.date)}</span>
              <span>{CATEGORY_LABELS[currentItem.category]}</span>
            </div>
          </div>
          {currentItem.isSeed ? <span className="badge">示例数据</span> : null}
        </div>

        <div className="content-stack">
          {currentItem.ai ? (
            <section className={`verdict-card ${currentItem.ai.verdict === "reunion" ? "reunion" : ""}`}>
              <p className="eyebrow">{currentItem.ai.verdict === "reunion" ? "这不是第一次" : "一件新的遇见"}</p>
              <h2>{currentItem.ai.verdict === "reunion" ? "重逢" : "初见"}</h2>
              <p>{currentItem.ai.memorySentence}</p>
              {currentItem.ai.verdict === "reunion" && related ? (
                <div className="compare-grid">
                  <figure>
                    <img src={currentItem.photo} alt={`现在的${currentItem.name}`} />
                    <figcaption>现在 · {currentItem.place}</figcaption>
                  </figure>
                  <figure>
                    <img src={related.photo} alt={`过去的${related.name}`} />
                    <figcaption>那一次 · {related.place} · {formatDate(related.date)}</figcaption>
                  </figure>
                </div>
              ) : null}
              {currentItem.ai.verdict === "reunion" && !related ? (
                <div className="status-note warning" style={{ marginTop: 12 }}>
                  <MapPin size={14} />
                  <span>关联的历史记录已被删除，仍保留这次重逢结论。</span>
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

          {currentItem.ai ? (
            <section className="content-card surface museum-section">
              <p className="eyebrow">AI 博物志</p>
              <div className="museum-section">
                <h2>它是什么</h2>
                <p>{currentItem.ai.cognition}</p>
              </div>
              <div className="museum-section">
                <h2>有趣在哪</h2>
                <p>{currentItem.ai.fun}</p>
              </div>
              <div className="museum-section">
                <h2>你有多幸运</h2>
                <p>{currentItem.ai.luck.text}</p>
                <div className={currentItem.ai.luck.confidence === "low" ? "basis low-confidence" : "basis"}>
                  依据：{currentItem.ai.luck.basis}
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
              {currentItem.heard || currentItem.userNote || "那一刻，你还没有留下话。"}
            </p>
            {currentItem.heard ? (
              <div className="basis">来自视频中你说的话</div>
            ) : null}
            {currentItem.placeSource === "voice" ? (
              <div className="status-note" style={{ marginTop: 12 }}>
                <MessageCircle size={14} />
                <span>地点文字来自你在视频里说的话，并由你保存前确认。</span>
              </div>
            ) : null}
            {currentItem.locationSource !== "gps" ? (
              <div className="status-note warning" style={{ marginTop: 12 }}>
                <MapPin size={14} />
                <span>
                  {currentItem.locationSource === "previous"
                    ? "地图坐标沿用了同地点的已确认藏品。"
                    : currentItem.locationSource === "default"
                      ? "未获取定位，暂以深圳记录。"
                      : currentItem.lat === null || currentItem.lng === null
                        ? "没有可信拍摄坐标，这条记录不会显示地图 pin。"
                        : "地点由你手动填写。"}
                </span>
              </div>
            ) : null}
          </section>

          {currentItem.ai?.question ? (
            <section className="content-card surface">
              <p className="eyebrow"><MessageCircle size={13} /> 它问你</p>
              <div className="question-box">
                <strong>{currentItem.ai.question}</strong>
                <p>{currentItem.answer || "这个回答可以以后再补。"}</p>
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

          <ShareCard item={currentItem} />
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
