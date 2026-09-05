"use client";

import { ArrowLeft, Check, MapPin, PenLine } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/db";
import { createTextCardDataUrl } from "@/lib/text-card";
import type { Item, LocationSource, PlaceSource } from "@/lib/types";
import styles from "./TextEncounter.module.css";

export function TextEncounter({
  initialPlace,
  initialCountry,
  coordinate,
  onCancel,
}: {
  initialPlace: string;
  initialCountry: string;
  coordinate: {
    lat: number;
    lng: number;
    source: LocationSource;
  } | null;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (saving) return;
    if (!note.trim()) {
      setError("先写下一点此刻想记住的事。");
      return;
    }
    setSaving(true);
    setError("");
    const now = new Date().toISOString();
    const title = note.trim().replace(/\s+/g, " ").slice(0, 22);
    const placeSource: PlaceSource = coordinate
      ? coordinate.source === "gps"
        ? "gps"
        : coordinate.source === "exif"
          ? "exif"
          : coordinate.source
      : "unavailable";
    const item: Item = {
      id: nanoid(),
      name: title || "一段旅行心事",
      category: "other",
      photo: createTextCardDataUrl(note),
      place: coordinate ? initialPlace.trim() || "当前位置" : "?",
      country: coordinate ? initialCountry || "UNK" : "UNK",
      lat: coordinate?.lat ?? null,
      lng: coordinate?.lng ?? null,
      locationSource: coordinate?.source ?? "unavailable",
      placeSource,
      date: now,
      dateSource: "imported",
      userNote: note.trim(),
      ai: null,
      isSeed: false,
      createdAt: now,
    };
    try {
      await db.items.put(item);
      router.push(`/item/${item.id}`);
    } catch {
      setError("文字记录暂时没有保存成功，请检查浏览器存储空间。");
      setSaving(false);
    }
  }

  return (
    <main className={`app-shell ${styles.textShell}`}>
      <div className={`phone-page ${styles.textPage}`}>
        <header className={`page-header ${styles.textHeader}`}>
          <button className="icon-action" onClick={onCancel} aria-label="返回">
            <ArrowLeft size={17} />
          </button>
          <div className="brand-lockup">
            <h1>只写字</h1>
            <span>没有照片也能记住</span>
          </div>
          <PenLine size={18} color="var(--teal)" />
        </header>

        <div className={`form-stack ${styles.textForm}`}>
          <section className="form-card surface">
            <div className="field">
              <label htmlFor="text-note">今天想留下什么？</label>
              <textarea
                id="text-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={300}
                placeholder="写下旅途中没有说出口的心事……"
              />
            </div>
            <div className={styles.autoLocation}>
              <MapPin size={13} />
              <span>{coordinate ? `自动记录于 ${initialPlace || "当前位置"}` : "地点待补充，可在详情页手动填写"}</span>
            </div>
          </section>

          {error ? <div className="error-box">{error}</div> : null}
          <button
            className="primary-action"
            onClick={() => void save()}
            disabled={saving}
          >
            <Check size={18} />
            {saving ? "正在保存…" : "保存文字记录"}
          </button>
        </div>
      </div>
    </main>
  );
}
