"use client";

import { ArrowLeft, Check, CircleAlert, LoaderCircle, RotateCcw, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/db";
import { compressImage } from "@/lib/image";
import { readImageCapturedDate } from "@/lib/image-date";
import { recognizeResultSchema } from "@/lib/schema";
import { toHistoryEntry } from "@/lib/history";
import type { Item, RecognizedAi } from "@/lib/types";
import { COUNTRY_OPTIONS } from "@/lib/iso";

type BatchStatus = "pending" | "processing" | "success" | "failed";

type BatchEntry = {
  id: string;
  file: File;
  status: BatchStatus;
  error?: string;
  itemId?: string;
};

function messageForCode(code: string): string {
  if (code === "IMAGE_TOO_LARGE") return "图片压缩后仍然太大";
  if (code === "INVALID_MODEL_OUTPUT") return "模型返回格式不完整";
  if (code === "UNRECOGNIZED") return "这张照片没有识别出来";
  if (code === "LOCAL_STORAGE_ERROR") return "浏览器存储空间不足";
  return "网络或模型服务暂时不可用";
}

function normalizedPlace(value: string): string {
  return value.toLocaleLowerCase().replace(/[·•,，。.\s\-_/]/g, "");
}

export function BatchImport({
  files,
  history,
  initialPlace,
  initialCountry,
  onCancel,
}: {
  files: File[];
  history: Item[];
  initialPlace: string;
  initialCountry: string;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [place, setPlace] = useState(initialPlace);
  const [country, setCountry] = useState(initialCountry);
  const [entries, setEntries] = useState<BatchEntry[]>(
    files.slice(0, 8).map((file) => ({
      id: nanoid(),
      file,
      status: "pending",
    })),
  );
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function patchEntry(id: string, patch: Partial<BatchEntry>) {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  function matchingLocation(items: Item[]) {
    const target = normalizedPlace(place);
    if (!target) return undefined;
    return [...items]
      .sort((a, b) => b.date.localeCompare(a.date))
      .find((item) => {
        const candidate = normalizedPlace(item.place);
        return (
          item.lat !== null &&
          item.lng !== null &&
          item.locationSource !== "default" &&
          item.locationSource !== "manual" &&
          item.country === country &&
          (candidate.includes(target) || target.includes(candidate))
        );
      });
  }

  async function processEntry(entry: BatchEntry, currentHistory: Item[]) {
    patchEntry(entry.id, { status: "processing", error: undefined });
    try {
      const image = await compressImage(entry.file);
      const response = await fetch("/api/recognize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image,
          userNote: "",
          history: currentHistory.map(toHistoryEntry),
        }),
        signal: abortRef.current?.signal,
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const failed = payload as { code?: string };
        throw new Error(failed.code ?? "MODEL_ERROR");
      }
      const result = recognizeResultSchema.parse(payload);
      if (result.unrecognized) throw new Error("UNRECOGNIZED");
      if (
        result.verdict === "reunion" &&
        result.relatedItemId &&
        !currentHistory.some((item) => item.id === result.relatedItemId)
      ) {
        throw new Error("INVALID_RELATED_ITEM");
      }

      const captured = await readImageCapturedDate(entry.file);
      const coordinate = matchingLocation(currentHistory);
      const item: Item = {
        id: entry.id,
        name: result.name,
        nameEn: result.nameEn ?? undefined,
        category: result.category,
        photo: image,
        place: place.trim(),
        country,
        lat: coordinate?.lat ?? null,
        lng: coordinate?.lng ?? null,
        locationSource: coordinate ? "previous" : "manual",
        placeSource: "manual",
        date: captured.date,
        dateSource: captured.source,
        userNote: "",
        ai: {
          cognition: result.cognition,
          fun: result.fun,
          luck: result.luck,
          question: result.question,
          verdict: result.verdict,
          relatedItemId: result.relatedItemId,
          memorySentence: result.memorySentence,
        } satisfies RecognizedAi,
        isSeed: false,
        createdAt: new Date().toISOString(),
      };
      try {
        await db.items.put(item);
      } catch {
        throw new Error("LOCAL_STORAGE_ERROR");
      }
      patchEntry(entry.id, {
        status: "success",
        itemId: item.id,
        error: undefined,
      });
      return item;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        patchEntry(entry.id, { status: "pending" });
        return null;
      }
      const code = caught instanceof Error ? caught.message : "MODEL_ERROR";
      patchEntry(entry.id, { status: "failed", error: messageForCode(code) });
      if (code === "LOCAL_STORAGE_ERROR") throw caught;
      return null;
    }
  }

  async function run(ids?: Set<string>) {
    if (running || !place.trim() || !country) return;
    setRunning(true);
    setStopped(false);
    abortRef.current = new AbortController();
    let currentHistory = await db.items.orderBy("date").toArray();
    try {
      for (const entry of entries) {
        if (abortRef.current.signal.aborted) break;
        if (ids ? !ids.has(entry.id) : entry.status === "success") continue;
        const saved = await processEntry(entry, currentHistory);
        if (saved) currentHistory = [...currentHistory, saved];
      }
    } catch {
      setStopped(true);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const completed = entries.filter((entry) => entry.status === "success").length;
  const failed = entries.filter((entry) => entry.status === "failed");
  const processingIndex = entries.findIndex((entry) => entry.status === "processing");

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={onCancel} aria-label="取消批量显影">
            <ArrowLeft size={17} />
          </button>
          <div className="brand-lockup">
            <h1>批量显影</h1>
            <span>最多 8 张，逐张处理</span>
          </div>
          <span className="muted">{completed}/{entries.length}</span>
        </header>

        <section className="form-card surface">
          <p className="eyebrow">这批照片在哪里</p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="batch-place">地点</label>
              <input
                id="batch-place"
                value={place}
                onChange={(event) => setPlace(event.target.value)}
                maxLength={120}
              />
            </div>
            <div className="field">
              <label htmlFor="batch-country">国家</label>
              <select
                id="batch-country"
                value={country}
                onChange={(event) => setCountry(event.target.value)}
              >
                <option value="">请选择</option>
                <option value="UNK">位置未定</option>
                {COUNTRY_OPTIONS.map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="status-note" style={{ marginTop: 12 }}>
            <CircleAlert size={14} />
            <span>
              照片不含可信坐标时不会生成地图 pin；地点与已有记录匹配时，才沿用那条已确认坐标。
            </span>
          </div>
        </section>

        <div className="batch-list">
          {entries.map((entry, index) => (
            <div className="batch-row surface" key={entry.id}>
              <span className="batch-number">{index + 1}</span>
              <span className="batch-name">{entry.file.name}</span>
              <span className={`batch-status ${entry.status}`}>
                {entry.status === "processing" ? <LoaderCircle size={14} /> : null}
                {entry.status === "success" ? <Check size={14} /> : null}
                {entry.status === "failed" ? <CircleAlert size={14} /> : null}
                {entry.status === "pending"
                  ? "等待"
                  : entry.status === "processing"
                    ? "显影中"
                    : entry.status === "success"
                      ? "已保存"
                      : entry.error}
              </span>
            </div>
          ))}
        </div>

        {running ? (
          <div className="status-note" role="status" aria-live="polite">
            正在显影 {processingIndex + 1} / {entries.length}，请保持页面打开。
          </div>
        ) : null}
        {stopped ? (
          <div className="error-box" role="alert">浏览器存储失败，已停止后续模型调用。</div>
        ) : null}

        {running ? (
          <button
            className="secondary-action"
            onClick={() => abortRef.current?.abort()}
          >
            <X size={17} />
            停止
          </button>
        ) : completed < entries.length ? (
          <button
            className="primary-action"
            onClick={() => void run()}
            disabled={!place.trim() || !country}
          >
            开始显影 {entries.length} 张
          </button>
        ) : (
          <button className="primary-action" onClick={() => router.push("/")}>
            <Check size={18} />
            返回地图
          </button>
        )}
        {!running && failed.length ? (
          <button
            className="secondary-action"
            onClick={() =>
              void run(new Set(failed.map((entry) => entry.id)))
            }
          >
            <RotateCcw size={16} />
            重试失败的 {failed.length} 张
          </button>
        ) : null}
      </div>
    </main>
  );
}
