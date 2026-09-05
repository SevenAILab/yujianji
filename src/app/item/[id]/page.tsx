"use client";

import {
  ArrowLeft,
  CircleAlert,
  MapPin,
  MessageCircle,
  Send,
  X,
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
import styles from "./item-detail.module.css";

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
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState("");
  const [actionError, setActionError] = useState("");
  const [redeveloping, setRedeveloping] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [manualPlace, setManualPlace] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState("");

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

  async function submitAnswer() {
    const submittedAnswer = answer.trim();
    if (!submittedAnswer || replying || currentItem.reply) return;
    try {
      await db.items.update(currentItem.id, { answer: submittedAnswer });
      setReplying(true);
      setReplyError("");
      const question = currentItem.ai?.question;
      if (!question) return;
      const response = await fetch("/api/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemName: currentItem.name,
          userNote: currentItem.userNote,
          question,
          answer: submittedAnswer,
        }),
      });
      const payload = (await response.json()) as { reply?: string; error?: string };
      if (!response.ok || !payload.reply) {
        throw new Error(payload.error ?? "回应暂时生成不出来，请重试。");
      }
      await db.items.update(currentItem.id, { reply: payload.reply });
    } catch {
      setReplyError("回应暂时没有生成，请再试一次。");
    } finally {
      setReplying(false);
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

  async function saveLocation() {
    const enteredPlace = manualPlace.trim();
    if (savingLocation) return;
    if (enteredPlace.length < 2) {
      setLocationError("请至少输入两个字的城市或地点名称。");
      return;
    }
    setSavingLocation(true);
    setLocationError("");
    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ place: enteredPlace }),
      });
      const result = (await response.json()) as {
        found?: boolean;
        lat?: number;
        lng?: number;
        country?: string;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.code === "GEOCODER_UNAVAILABLE"
            ? "地点服务暂时不可用，请稍后再试。"
            : "地点暂时无法解析，请稍后再试。",
        );
      }
      if (
        !result.found ||
        typeof result.lat !== "number" ||
        typeof result.lng !== "number"
      ) {
        throw new Error("没有找到这个地点，请补充城市、省份或国家后再试。");
      }
      await db.items.update(currentItem.id, {
        place: enteredPlace,
        country: result.country || "UNK",
        lat: result.lat,
        lng: result.lng,
        locationSource: "manual",
        placeSource: "manual",
      });
      setEditingLocation(false);
      setManualPlace("");
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : "地点暂时没有保存成功，请重试。");
    } finally {
      setSavingLocation(false);
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
    <main className={`app-shell ${styles.itemShell}`}>
      <div className={`phone-page ${styles.itemPage}`}>
        <header className={`page-header ${styles.itemHeader}`}>
          <button className="icon-action" onClick={() => router.back()} aria-label="返回">
            <ArrowLeft size={18} />
          </button>
          <span className="muted">{formatMonth(currentItem.date)}</span>
          <button className={`icon-action ${styles.itemDeleteButton}`} onClick={() => void deleteItem()} aria-label="删除藏品">
            <X size={19} strokeWidth={1.7} />
          </button>
        </header>

        <div className="hero-photo">
          <img src={currentItem.photo} alt={currentItem.name} />
        </div>

        <div className="detail-title">
          <div>
            <h1>{currentItem.name}</h1>
            <div className="detail-meta">
              {currentItem.lat === null || currentItem.lng === null ? (
                <button
                  className={styles.missingLocationButton}
                  onClick={() => {
                    setEditingLocation((value) => !value);
                    setLocationError("");
                  }}
                  aria-label="补充地点"
                >
                  <MapPin size={13} /> ?
                </button>
              ) : (
                <span><MapPin size={13} /> {currentItem.place}</span>
              )}
              <span>{formatDate(currentItem.date)}</span>
              <span>{CATEGORY_LABELS[currentItem.category]}</span>
            </div>
            {editingLocation ? (
              <div className={styles.locationEditor}>
                <input
                  value={manualPlace}
                  onChange={(event) => setManualPlace(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveLocation();
                  }}
                  placeholder="输入城市或地点，例如：福州"
                  maxLength={120}
                  autoFocus
                />
                <button onClick={() => void saveLocation()} disabled={savingLocation}>
                  {savingLocation ? "查找中" : "保存"}
                </button>
              </div>
            ) : null}
            {editingLocation && locationError ? (
              <p className={styles.locationError}>{locationError}</p>
            ) : null}
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
            {currentItem.locationSource !== "gps" && currentItem.locationSource !== "exif" ? (
              <div className="status-note warning" style={{ marginTop: 12 }}>
                <MapPin size={14} />
                <span>
                  {currentItem.locationSource === "previous"
                    ? "地图坐标沿用了同地点的已确认藏品。"
                    : currentItem.locationSource === "default"
                      ? "未获取定位，暂以深圳记录。"
                    : currentItem.locationSource === "unavailable" || currentItem.lat === null || currentItem.lng === null
                        ? "地点还没有补充，因此暂不显示地图 pin。点击上方的问号可手动填写。"
                        : "地点由你手动填写。"}
                </span>
              </div>
            ) : null}
          </section>

          {currentItem.ai?.question ? (
            <section className="content-card surface">
              <p className="eyebrow"><MessageCircle size={13} /> 评论</p>
              <div className="comment-thread">
                <div className="comment-row">
                  <div className="comment-avatar comment-avatar-ai">集</div>
                  <div className="comment-body">
                    <div className="comment-name">遇见集</div>
                    <div className="comment-text">{currentItem.ai.question}</div>
                    <div className="comment-time">刚刚</div>
                  </div>
                </div>
                {currentItem.answer ? (
                  <div className="comment-row comment-reply">
                    <div className="comment-avatar comment-avatar-user">我</div>
                    <div className="comment-body">
                      <div className="comment-name">我</div>
                      <div className="comment-text">{currentItem.answer}</div>
                      <div className="comment-time">刚刚</div>
                    </div>
                  </div>
                ) : null}
                {replying ? (
                  <div className="comment-row comment-reply">
                    <div className="comment-avatar comment-avatar-ai"><MessageCircle size={15} /></div>
                    <div className="comment-body">
                      <div className="comment-name">遇见集</div>
                      <div className="comment-text comment-pending">正在回应…</div>
                    </div>
                  </div>
                ) : currentItem.reply ? (
                  <div className="comment-row comment-reply">
                    <div className="comment-avatar comment-avatar-ai">集</div>
                    <div className="comment-body">
                      <div className="comment-name">遇见集</div>
                      <div className="comment-text">{currentItem.reply}</div>
                      <div className="comment-time">刚刚</div>
                    </div>
                  </div>
                ) : currentItem.answer ? (
                  <div className="comment-retry">
                    <span>{replyError || "这条回答还没有收到回应。"}</span>
                    <button type="button" onClick={() => void submitAnswer()}>让它再说一次</button>
                  </div>
                ) : !currentItem.answer ? (
                  <div className="comment-input-row">
                    <textarea
                      id="answer"
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      placeholder="说点什么…"
                      maxLength={300}
                      rows={1}
                    />
                    <button
                      className="comment-send"
                      type="button"
                      aria-label="发送回答"
                      onClick={() => void submitAnswer()}
                      disabled={!answer.trim() || replying}
                    >
                      <Send size={16} />
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <ShareCard item={currentItem} />
          {actionError ? <div className="error-box">{actionError}</div> : null}

          <div className="action-row">
            <button className={`primary-action ${styles.returnJourneyButton}`} onClick={() => router.push("/journeys")}>
              返回旅途
            </button>
          </div>
        </div>
      </div>
      <AppNav />
    </main>
  );
}
