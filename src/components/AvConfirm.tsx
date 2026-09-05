"use client";

import { Check, CircleAlert, MapPin, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/db";
import type { AvDraft } from "@/lib/av-draft";
import type { Item, RecognizedAi } from "@/lib/types";

type EditableSegment = AvDraft["segments"][number] & {
  selected: boolean;
  saveAsFirst: boolean;
};

export function AvConfirm({
  draft,
  history,
  onCancel,
}: {
  draft: AvDraft;
  history: Item[];
  onCancel: () => void;
}) {
  const router = useRouter();
  const [segments, setSegments] = useState<EditableSegment[]>(
    draft.segments.map((segment) => ({
      ...segment,
      selected: true,
      saveAsFirst: false,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedCount = segments.filter((segment) => segment.selected).length;
  const place = draft.initialPlace || draft.coordinate?.place || "?";
  const country = draft.initialCountry || draft.coordinate?.country || "UNK";
  const relatedById = useMemo(
    () => new Map(history.map((item) => [item.id, item])),
    [history],
  );

  function updateSegment(
    occurrenceId: string,
    patch: Partial<EditableSegment>,
  ) {
    setSegments((current) =>
      current.map((segment) =>
        segment.occurrenceId === occurrenceId
          ? { ...segment, ...patch }
          : segment,
      ),
    );
  }

  async function save() {
    if (saving) return;
    const chosen = segments.filter((segment) => segment.selected);
    if (!chosen.length) {
      setError("至少保留一张卡片，或者返回重新选择视频。");
      return;
    }
    if (chosen.some((segment) => !segment.name.trim())) {
      setError("请为每张要保存的卡片填写名称。");
      return;
    }

    const now = new Date().toISOString();
    const records: Item[] = chosen.map((segment) => {
      const verdict = segment.saveAsFirst ? "first" : segment.verdict;
      const related = segment.relatedItemId
        ? relatedById.get(segment.relatedItemId)
        : undefined;
      if (
        verdict === "reunion" &&
        (!related ||
          related.category !== segment.category ||
          related.name !== segment.relatedItemName)
      ) {
        throw new Error("这张卡片的历史关联已失效，请重新显影。");
      }
      const ai: RecognizedAi = {
        cognition: segment.cognition,
        fun: segment.fun,
        luck: segment.luck,
        question: segment.question,
        verdict,
        relatedItemId:
          verdict === "reunion" ? segment.relatedItemId : null,
        memorySentence:
          verdict === "first" && segment.verdict === "reunion"
            ? `第一次遇见${segment.name}，已经替你记下来了。`
            : segment.memorySentence,
      };
      return {
        id: segment.occurrenceId,
        name: segment.name.trim(),
        nameEn: segment.nameEn,
        category: segment.category,
        photo: draft.frames[segment.frameIndex].dataUrl,
        place,
        country,
        lat: draft.coordinate?.lat ?? null,
        lng: draft.coordinate?.lng ?? null,
        locationSource: draft.coordinate?.source ?? "unavailable",
        placeSource: draft.initialPlaceSource,
        date: draft.capturedAt,
        dateSource: draft.dateSource,
        userNote: "",
        heard: segment.heard,
        ai,
        isSeed: false,
        createdAt: now,
      };
    });

    setSaving(true);
    setError("");
    try {
      const estimate = await navigator.storage?.estimate?.();
      const available =
        estimate?.quota !== undefined && estimate.usage !== undefined
          ? estimate.quota - estimate.usage
          : undefined;
      const estimatedBytes = records.reduce(
        (total, record) => total + record.photo.length * 0.75,
        0,
      );
      if (available !== undefined && available < estimatedBytes + 1_000_000) {
        throw new Error("浏览器可用存储空间不足，请减少保存的卡片。");
      }
      await db.transaction("rw", db.items, async () => {
        await db.items.bulkPut(records);
      });
      router.push("/");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "这批记录暂时没有保存成功，请重试。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={onCancel} aria-label="返回重新选择">
            <RotateCcw size={17} />
          </button>
          <div className="brand-lockup">
            <h1>确认这次遇见</h1>
            <span>{draft.segments.length} 样东西</span>
          </div>
          <span className="muted">{selectedCount} 张</span>
        </header>

        <section className="form-card surface">
          <p className="eyebrow">自动记录</p>
          {draft.truncated ? (
            <div className="status-note warning" role="status">
              <CircleAlert size={15} />
              <span>这段视频较长，只处理了前 60 秒；原视频不会保存。</span>
            </div>
          ) : null}
          <div className="status-note">
            <MapPin size={15} />
            <span>
              {draft.coordinate
                ? `已自动记录 ${place}，保存后会同步到地图与旅程。`
                : "当前没有可用坐标，这次记录不会生成错误的地图位置。"}
            </span>
          </div>
        </section>

        <div className="av-confirm-list">
          {segments.map((segment) => {
            const related = segment.relatedItemId
              ? relatedById.get(segment.relatedItemId)
              : undefined;
            return (
              <article
                className={`av-confirm-card surface ${segment.selected ? "" : "disabled"}`}
                key={segment.occurrenceId}
              >
                <label className="av-card-select">
                  <input
                    type="checkbox"
                    checked={segment.selected}
                    onChange={(event) =>
                      updateSegment(segment.occurrenceId, {
                        selected: event.target.checked,
                      })
                    }
                  />
                  <span>{segment.selected ? "保留" : "不保存"}</span>
                </label>
                <img
                  className="av-frame"
                  src={draft.frames[segment.frameIndex].dataUrl}
                  alt=""
                />
                <div className="field">
                  <label htmlFor={`segment-${segment.occurrenceId}`}>名称</label>
                  <input
                    id={`segment-${segment.occurrenceId}`}
                    value={segment.name}
                    maxLength={80}
                    onChange={(event) =>
                      updateSegment(segment.occurrenceId, {
                        name: event.target.value,
                      })
                    }
                  />
                </div>
                <blockquote>“{segment.heard || "这句话没有听清"}”</blockquote>
                <div className={`av-verdict ${segment.verdict === "reunion" && !segment.saveAsFirst ? "reunion" : ""}`}>
                  <strong>
                    {segment.verdict === "reunion" && !segment.saveAsFirst
                      ? "重逢"
                      : "初见"}
                  </strong>
                  {related && !segment.saveAsFirst ? (
                    <div className="av-related">
                      <img src={related.photo} alt="" />
                      <span>
                        关联到：{related.name}<br />
                        <small>{related.place}</small>
                      </span>
                    </div>
                  ) : null}
                  {segment.associationStatus === "uncertain" && !segment.saveAsFirst ? (
                    <p className="low-confidence">
                      <CircleAlert size={13} />
                      这次关联把握较低，请重点核对。
                    </p>
                  ) : null}
                  {segment.verdict === "reunion" ? (
                    <button
                      className="text-action"
                      onClick={() =>
                        updateSegment(segment.occurrenceId, {
                          saveAsFirst: !segment.saveAsFirst,
                        })
                      }
                    >
                      {segment.saveAsFirst ? "恢复重逢" : "按初见保存"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>

        {error ? <div className="error-box">{error}</div> : null}
        <button
          className="primary-action"
          onClick={() => void save()}
          disabled={saving || selectedCount === 0}
        >
          <Check size={18} />
          {saving ? "正在保存…" : `保存 ${selectedCount} 张卡片`}
        </button>
        <p className="privacy-note">
          原视频与音频不会保存；只有你确认的画面帧和记录会留在本机浏览器。
        </p>
      </div>
    </main>
  );
}
