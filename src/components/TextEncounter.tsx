"use client";

import { ArrowLeft, Check, PenLine } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/db";
import { createTextCardDataUrl } from "@/lib/text-card";
import {
  CATEGORY_OPTIONS,
  type Category,
  type Item,
  type LocationSource,
} from "@/lib/types";
import { COUNTRY_OPTIONS } from "@/lib/iso";

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
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("other");
  const [note, setNote] = useState("");
  const [place, setPlace] = useState(initialPlace);
  const [country, setCountry] = useState(initialCountry);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (saving) return;
    if (!name.trim() || !note.trim() || !place.trim() || !country) {
      setError("请填写名称、那句话、地点和国家。");
      return;
    }
    setSaving(true);
    setError("");
    const now = new Date().toISOString();
    const coordinateStillApplies =
      place.trim() === initialPlace && country === initialCountry;
    const item: Item = {
      id: nanoid(),
      name: name.trim(),
      category,
      photo: createTextCardDataUrl(note),
      place: place.trim(),
      country,
      lat: coordinateStillApplies ? coordinate?.lat ?? null : null,
      lng: coordinateStillApplies ? coordinate?.lng ?? null : null,
      locationSource: coordinateStillApplies
        ? coordinate?.source ?? "manual"
        : "manual",
      placeSource: "manual",
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
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={onCancel} aria-label="返回">
            <ArrowLeft size={17} />
          </button>
          <div className="brand-lockup">
            <h1>只写字</h1>
            <span>没有照片也能记住</span>
          </div>
          <PenLine size={18} color="var(--teal)" />
        </header>

        <div className="form-stack">
          <section className="form-card surface">
            <div className="field">
              <label htmlFor="text-name">这次遇见叫什么</label>
              <input
                id="text-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="比如：傍晚闻到的桂花"
              />
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="text-category">分类</label>
              <select
                id="text-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as Category)}
              >
                {CATEGORY_OPTIONS.map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="text-note">留下那句话</label>
              <textarea
                id="text-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={300}
                placeholder="把当时最想记住的一句话写下来"
              />
            </div>
          </section>

          <section className="form-card surface">
            <div className="field-row">
              <div className="field">
                <label htmlFor="text-place">地点</label>
                <input
                  id="text-place"
                  value={place}
                  onChange={(event) => setPlace(event.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="field">
                <label htmlFor="text-country">国家</label>
                <select
                  id="text-country"
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
