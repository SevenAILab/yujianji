"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  Globe2,
  ImagePlus,
  MapPin,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { AppNav } from "@/components/AppNav";
import { VoiceButton } from "@/components/VoiceButton";
import { db, ensureSeeded } from "@/lib/db";
import { detectCountryFromPosition } from "@/lib/country";
import { compressImage } from "@/lib/image";
import { getPosition, type Position, type PositionFailure } from "@/lib/geo";
import { toHistoryEntry } from "@/lib/history";
import { CATEGORY_OPTIONS, type Category, type Item, type RecognizedAi } from "@/lib/types";
import { recognizeResultSchema } from "@/lib/schema";
import { COUNTRY_OPTIONS, countryName } from "@/lib/iso";

type LocationStatus = {
  source: "gps" | "previous" | "default" | "manual";
  text: string;
  position: Position;
  countryDetected: boolean;
};

function positionFailureText(failure: PositionFailure | null): string {
  if (failure === "unsupported") return "这台设备不支持定位。";
  if (failure === "denied") return "定位权限没有开启。";
  if (failure === "timeout") return "定位超时了。";
  return "暂时没有拿到当前位置。";
}

function errorMessage(code: string): string {
  if (code === "IMAGE_TOO_LARGE") return "图片太大了，请换一张更小的照片。";
  if (code === "MODEL_TIMEOUT") return "模型这次响应有点慢，请重试。";
  if (code === "INVALID_MODEL_OUTPUT") return "模型没有给出可用的显影结果，请重试。";
  if (code === "INVALID_RELATED_ITEM") return "历史关联没有确认成功，请再试一次。";
  if (code === "LOCAL_STORAGE_ERROR") return "这台设备暂时无法保存记录，请检查浏览器存储空间后重试。";
  return "网络或模型服务暂时不可用，请重试。";
}

export default function EncounterPage() {
  const router = useRouter();
  const [preview, setPreview] = useState("");
  const [userNote, setUserNote] = useState("");
  const [place, setPlace] = useState("");
  const [country, setCountry] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualCategory, setManualCategory] = useState<Category>("other");
  const [items, setItems] = useState<Item[]>([]);
  const [location, setLocation] = useState<LocationStatus | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let active = true;

    function applyFallbackLocation(history: Item[]) {
      const previous = [...history].sort((a, b) =>
        b.date.localeCompare(a.date),
      )[0];
      if (previous) {
        setCountry(previous.country === "UNK" ? "" : previous.country);
        setLocation({
          source: "previous",
          text: "正在尝试获取当前位置；暂按你上一条藏品的位置记录。",
          position: { lat: previous.lat, lng: previous.lng },
          countryDetected: false,
        });
      } else {
        setLocation({
          source: "default",
          text: "正在尝试获取当前位置；暂以深圳记录。",
          position: { lat: 22.54, lng: 114.06 },
          countryDetected: false,
        });
      }
    }

    async function loadContext() {
      try {
        await ensureSeeded();
        const history = await db.items.orderBy("date").toArray();
        if (!active) return;
        setItems(history);
        const previous = [...history].sort((a, b) => b.date.localeCompare(a.date))[0];
        if (previous) {
          setPlace(previous.place);
        }
        applyFallbackLocation(history);
        setLocationLoading(true);

        const positionResult = await getPosition();
        if (!active) return;
        if (positionResult.position) {
          const detectedCountry = detectCountryFromPosition(
            positionResult.position.lat,
            positionResult.position.lng,
          );
          setCountry(detectedCountry ?? "");
          setLocation({
            source: "gps",
            text: detectedCountry
              ? "已获取当前位置，并自动判断国家。地点名称仍由你确认。"
              : "已获取坐标，但当前位置无法判断国家，请手动选择。",
            position: positionResult.position,
            countryDetected: Boolean(detectedCountry),
          });
        } else if (previous) {
          setLocation({
            source: "previous",
            text: `${positionFailureText(positionResult.failure)}已按你上一条藏品的位置记录。`,
            position: { lat: previous.lat, lng: previous.lng },
            countryDetected: false,
          });
        } else {
          setLocation({
            source: "default",
            text: `${positionFailureText(positionResult.failure)}暂以深圳记录；位置来源会明确标注。`,
            position: { lat: 22.54, lng: 114.06 },
            countryDetected: false,
          });
        }
        setLocationLoading(false);
      } catch {
        if (!active) return;
        setLocation({
          source: "default",
          text: "历史载入失败，暂以深圳记录；位置来源会明确标注。",
          position: { lat: 22.54, lng: 114.06 },
          countryDetected: false,
        });
        setLocationLoading(false);
        setError("示例历史载入失败，请刷新后重试。");
      }
    }
    void loadContext();
    return () => {
      active = false;
    };
  }, []);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      setPreview(await compressImage(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
    }
  }

  async function submit() {
    if (isSubmittingRef.current) return;
    if (!preview) {
      setError("先选一张照片，再开始显影。");
      return;
    }
    if (!place.trim()) {
      setError("请补充你在哪里遇见它。");
      return;
    }
    if (locationLoading || !location) {
      setError("正在确认位置，请等定位状态完成后再显影。");
      return;
    }

    const occurrenceId = nanoid();
    isSubmittingRef.current = true;
    setLoading(true);
    setError("");
    setShowManual(false);

    try {
      const response = await fetch("/api/recognize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: preview,
          userNote,
          history: items.map(toHistoryEntry),
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const failed = payload as { code?: string; error?: string };
        throw new Error(failed.code ?? "MODEL_ERROR");
      }

      const result = recognizeResultSchema.parse(payload);
      if (result.unrecognized) {
        setShowManual(true);
        setError("这次还没认出来。可以手动填一个名字，把这次遇见先保存下来。");
        return;
      }
      if (
        result.verdict === "reunion" &&
        result.relatedItemId &&
        !(await db.items.get(result.relatedItemId))
      ) {
        throw new Error("INVALID_RELATED_ITEM");
      }

      const now = new Date().toISOString();
      const item: Item = {
        id: occurrenceId,
        name: result.name,
        nameEn: result.nameEn ?? undefined,
        category: result.category,
        photo: preview,
        place: place.trim(),
        country: country || "UNK",
        lat: location?.position.lat ?? 22.54,
        lng: location?.position.lng ?? 114.06,
        locationSource,
        date: now,
        userNote: userNote.trim(),
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
        createdAt: now,
      };
      try {
        await db.items.put(item);
      } catch {
        throw new Error("LOCAL_STORAGE_ERROR");
      }
      router.push(`/item/${item.id}`);
    } catch (caught) {
      setError(errorMessage(caught instanceof Error ? caught.message : "MODEL_ERROR"));
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
    }
  }

  async function saveManual() {
    if (savingManual) return;
    if (locationLoading || !location || !preview || !manualName.trim() || !place.trim() || !country) {
      setError("手动保存至少需要照片、名称、地点和国家。");
      return;
    }
    setSavingManual(true);
    const now = new Date().toISOString();
    const item: Item = {
      id: nanoid(),
      name: manualName.trim(),
      category: manualCategory,
      photo: preview,
      place: place.trim(),
      country: country || "UNK",
      lat: location?.position.lat ?? 22.54,
      lng: location?.position.lng ?? 114.06,
      locationSource,
      date: now,
      userNote: userNote.trim(),
      ai: null,
      isSeed: false,
      createdAt: now,
    };
    try {
      await db.items.put(item);
      router.push(`/item/${item.id}`);
    } catch {
      setError("这台设备暂时无法保存记录，请检查浏览器存储空间后重试。");
    } finally {
      setSavingManual(false);
    }
  }

  const showCountrySelector =
    !locationLoading && Boolean(location) && (!location?.countryDetected || location.source !== "gps");
  const locationSource = location?.source ?? "manual";

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={() => router.back()} aria-label="返回">
            <ArrowLeft size={18} />
          </button>
          <div className="brand-lockup">
            <h1>新增发现</h1>
            <span>显影一件遇见</span>
          </div>
          <Sparkles size={18} color="var(--teal)" />
        </header>

        <div className="form-stack">
          <section className="form-card surface">
            <p className="eyebrow">01 / 留下一张照片</p>
            <div className="file-actions">
              <label className="secondary-action">
                <Camera size={18} />
                拍一张
                <input
                  className="file-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                />
              </label>
              <label className="secondary-action">
                <ImagePlus size={18} />
                从相册选
                <input
                  className="file-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                />
              </label>
            </div>
            {preview ? (
              <div className="photo-preview">
                <img src={preview} alt="待显影的照片" />
              </div>
            ) : (
              <div className="empty-state">拍下一个你还叫不出名字的东西。</div>
            )}
          </section>

          <section className="form-card surface">
            <p className="eyebrow">02 / 留下一句话</p>
            <div className="field">
              <label htmlFor="note">你当时说了什么？</label>
              <div className="voice-field">
                <textarea
                  id="note"
                  value={userNote}
                  onChange={(event) => setUserNote(event.target.value)}
                  placeholder="比如：它怎么会长在这里？"
                  maxLength={300}
                />
                <VoiceButton value={userNote} onChange={setUserNote} />
              </div>
            </div>
            <div className="field-row" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="place">地点</label>
                <input
                  id="place"
                  value={place}
                  onChange={(event) => setPlace(event.target.value)}
                  placeholder="比如：浙江 · 莫干山"
                  maxLength={120}
                />
              </div>
              <div className="field">
                <label htmlFor="country">国家</label>
                {locationLoading ? (
                  <div className="readonly-field" aria-label="正在获取当前位置">
                    正在获取当前位置…
                  </div>
                ) : showCountrySelector ? (
                  <select
                    id="country"
                    value={country}
                    onChange={(event) => setCountry(event.target.value)}
                  >
                    <option value="">请选择</option>
                    <option value="UNK">位置未定</option>
                    {COUNTRY_OPTIONS.map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                ) : (
                  <div className="readonly-field" aria-label="自动判断的国家">
                    {countryName(country)}
                  </div>
                )}
              </div>
            </div>
            {!locationLoading && location ? (
              <div className={`status-note ${location.source === "default" ? "warning" : ""}`} style={{ marginTop: 12 }}>
                {location.source === "gps" ? <Check size={15} /> : <MapPin size={15} />}
                <span>{location.text}</span>
              </div>
            ) : null}
          </section>

          {error ? (
            <div className="error-box">
              {error}
              {showManual ? (
                <div className="content-stack" style={{ marginTop: 12 }}>
                  <div className="field">
                    <label htmlFor="manualName">手动填写名字</label>
                    <input
                      id="manualName"
                      value={manualName}
                      onChange={(event) => setManualName(event.target.value)}
                      placeholder="比如：一块有孔洞的石头"
                      maxLength={80}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="manualCategory">它更像</label>
                    <select
                      id="manualCategory"
                      value={manualCategory}
                      onChange={(event) => setManualCategory(event.target.value as Category)}
                    >
                      {CATEGORY_OPTIONS.map(([value, label]) => (
                        <option value={value} key={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <button className="secondary-action" onClick={() => void saveManual()} disabled={savingManual}>
                    <Check size={17} />
                    {savingManual ? "正在保存…" : "手动保存"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            className="primary-action"
            onClick={() => void submit()}
            disabled={loading || locationLoading || !location}
          >
            <Sparkles size={19} />
            {loading ? "正在显影…" : locationLoading ? "正在确认位置…" : "显影"}
          </button>
          {error && !showManual ? (
            <button
              className="secondary-action"
              onClick={() => void submit()}
              disabled={loading || locationLoading || !location}
            >
              <RotateCcw size={17} />
              重试
            </button>
          ) : null}
          <p className="privacy-note">
            照片、文字和语音只在识别期间临时发送给相应 AI 服务；应用服务端不保存这些内容。
          </p>
        </div>
      </div>
      <AppNav />
      {loading ? (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-inner">
            <div className="loading-orb" />
            <strong>正在显影…</strong>
            <span>让一件遇见慢慢显出名字，也看看我们是否早就见过。</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}
