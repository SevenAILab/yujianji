"use client";

import {
  ArrowLeft,
  Check,
  FileVideo2,
  MapPin,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { AppNav } from "@/components/AppNav";
import { AvConfirm } from "@/components/AvConfirm";
import { TextEncounter } from "@/components/TextEncounter";
import { VoiceButton } from "@/components/VoiceButton";
import { db, ensureSeeded } from "@/lib/db";
import { takePendingEncounterFile, type EncounterFileSource } from "@/lib/encounter-transfer";
import { createAvDraft, type AvDraft } from "@/lib/av-draft";
import {
  AvExtractionError,
  extractFramesAndAudio,
  jsonByteLength,
  MAX_AV_REQUEST_BYTES,
} from "@/lib/av";
import { detectCountryFromPosition } from "@/lib/country";
import { compressImage } from "@/lib/image";
import { readImageCapturedDate } from "@/lib/image-date";
import { readImageLocation } from "@/lib/image-location";
import { getPosition, type Position } from "@/lib/geo";
import { toHistoryEntry } from "@/lib/history";
import { CATEGORY_OPTIONS, type Category, type DateSource, type Item, type LocationSource, type PlaceSource, type RecognizedAi } from "@/lib/types";
import { avResponseSchema, recognizeResultSchema } from "@/lib/schema";
import styles from "./encounter.module.css";

type LocationStatus = {
  source: LocationSource;
  text: string;
  position: Position;
  countryDetected: boolean;
};

type ReverseGeocodeResponse = {
  place: string;
  displayName: string;
  country?: string;
};

async function identifyPosition(position: Position): Promise<ReverseGeocodeResponse> {
  const response = await fetch("/api/reverse-geocode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(position),
  });
  if (!response.ok) throw new Error("GEOCODER_UNAVAILABLE");
  return response.json() as Promise<ReverseGeocodeResponse>;
}

function placeSourceFor(source: LocationSource): PlaceSource {
  if (source === "gps" || source === "exif") return source;
  return source;
}

function errorMessage(code: string): string {
  if (code === "IMAGE_TOO_LARGE") return "图片太大了，请换一张更小的照片。";
  if (code === "MODEL_TIMEOUT") return "模型这次响应有点慢，请重试。";
  if (code === "INVALID_MODEL_OUTPUT") return "模型没有给出可用的显影结果，请重试。";
  if (code === "INVALID_RELATED_ITEM") return "历史关联没有确认成功，请再试一次。";
  if (code === "LOCAL_STORAGE_ERROR") return "这台设备暂时无法保存记录，请检查浏览器存储空间后重试。";
  if (code === "VIDEO_TOO_LONG") return "视频时长处理失败，请换一段更短的视频。";
  if (code === "VIDEO_TOO_LARGE") return "视频文件太大，请先在相册里截短后再试。";
  if (code === "NO_AUDIO") return "这段视频里没有可识别的声音。";
  if (code === "UNSUPPORTED_CODEC") return "这台浏览器无法解码视频，请在影石 App 中导出为兼容的 MP4 后再试。";
  if (code === "DECODE_TIMEOUT") return "视频处理超时，请换一段更短的视频。";
  if (code === "REQUEST_TOO_LARGE" || code === "FRAMES_TOO_LARGE" || code === "AUDIO_TOO_LARGE") {
    return "视频拆出的画面或声音仍然太大，请换一段更短的视频。";
  }
  if (code === "LOCATION_NOT_FOUND") return "没有找到这个地点，请补充城市、省份或国家后再试。";
  if (code === "GEOCODER_UNAVAILABLE") return "地点服务暂时不可用，尚未保存，避免把照片放到错误区域。";
  return "网络或模型服务暂时不可用，请重试。";
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

export default function EncounterPage() {
  const router = useRouter();
  const [preview, setPreview] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [capturedAt, setCapturedAt] = useState(() => new Date().toISOString());
  const [dateSource, setDateSource] = useState<DateSource>("imported");
  const [avDraft, setAvDraft] = useState<AvDraft | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [userNote, setUserNote] = useState("");
  const [place, setPlace] = useState("");
  const [country, setCountry] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualCategory, setManualCategory] = useState<Category>("other");
  const [items, setItems] = useState<Item[]>([]);
  const [location, setLocation] = useState<LocationStatus | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [error, setError] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const isSubmittingRef = useRef(false);
  const fileLocationAppliedRef = useRef(false);

  useEffect(() => {
    if (!loading || !preview || videoFile) return;
    const stages = [
      [4_000, "在翻你之前的记录…"],
      [9_000, "在想该问你点什么…"],
      [15_000, "快好了，它有点话多…"],
    ] as const;
    const timers = stages.map(([delay, stage]) =>
      window.setTimeout(() => setLoadingStage(stage), delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [loading, preview, videoFile]);

  useEffect(() => {
    let active = true;

    async function loadContext() {
      try {
        await ensureSeeded();
        const history = await db.items.orderBy("date").toArray();
        if (!active) return;
        setItems(history);
        setPlace("");
        setCountry("");
        setLocation(null);
        setLocationLoading(true);

        const positionResult = await getPosition();
        if (!active) return;
        if (positionResult.position) {
          setGeocodeLoading(true);
          let identified: ReverseGeocodeResponse | null = null;
          try {
            identified = await identifyPosition(positionResult.position);
          } catch {
            identified = null;
          } finally {
            if (active) setGeocodeLoading(false);
          }
          if (!active || fileLocationAppliedRef.current) return;
          const detectedCountry = identified?.country ?? detectCountryFromPosition(
            positionResult.position.lat,
            positionResult.position.lng,
          );
          setPlace(identified?.place ?? "当前位置");
          setCountry(detectedCountry ?? "");
          setLocation({
            source: "gps",
            text: identified
              ? `已自动定位到 ${identified.place}`
              : "已记录当前坐标，地点名称暂未识别。",
            position: positionResult.position,
            countryDetected: Boolean(detectedCountry),
          });
        } else {
          setPlace("");
          setCountry("");
          setLocation(null);
        }
        setLocationLoading(false);
      } catch {
        if (!active) return;
        setPlace("");
        setCountry("");
        setLocation(null);
        setLocationLoading(false);
        setError("示例历史载入失败，请刷新后重试。");
      }
    }
    void loadContext();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const pendingFile = takePendingEncounterFile();
    if (pendingFile) void handleFile(pendingFile.file, pendingFile.source);
    if (window.location.search.includes("mode=text")) setTextMode(true);
  }, []);

  async function handleFile(file: File | undefined, source: EncounterFileSource) {
    if (!file) return;
    setError("");
    setShowManual(false);
    if (isVideoFile(file)) {
      setPreview("");
      setVideoFile(file);
      return;
    }
    setVideoFile(null);
    try {
      const [compressed, captured] = await Promise.all([
        compressImage(file),
        readImageCapturedDate(file),
      ]);
      setPreview(compressed);
      setCapturedAt(captured.date);
      setDateSource(captured.source);
      if (source === "album") {
        setGeocodeLoading(true);
        const photoPosition = await readImageLocation(file);
        if (photoPosition) {
          fileLocationAppliedRef.current = true;
          let identified: ReverseGeocodeResponse | null = null;
          try {
            identified = await identifyPosition(photoPosition);
          } catch {
            identified = null;
          }
          const detectedCountry = identified?.country ?? detectCountryFromPosition(photoPosition.lat, photoPosition.lng);
          const detectedPlace = identified?.place ?? "照片拍摄地";
          setPlace(detectedPlace);
          setCountry(detectedCountry ?? "");
          setLocation({
            source: "exif",
            text: identified ? `已读取照片地点：${detectedPlace}` : "已读取照片坐标，地点名称暂未识别。",
            position: photoPosition,
            countryDetected: Boolean(detectedCountry),
          });
          setLocationLoading(false);
        } else {
          setLocation((current) => current ? {
            ...current,
            text: "照片没有保留地点元数据，已使用设备自动定位。",
          } : current);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
    } finally {
      if (source === "album") setGeocodeLoading(false);
    }
  }

  async function submit() {
    if (isSubmittingRef.current) return;
    if (!preview && !videoFile) {
      setError("先选择一张照片或一段视频，再开始显影。");
      return;
    }
    if (videoFile) {
      await submitVideo(videoFile);
      return;
    }
    if (locationLoading) {
      setError("正在确认位置，请等定位状态完成后再显影。");
      return;
    }

    const occurrenceId = nanoid();
    isSubmittingRef.current = true;
    setLoading(true);
    setLoadingStage("正在看这张照片…");
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
        place: location ? place.trim() || "当前位置" : "?",
        country: location
          ? country ||
            detectCountryFromPosition(location.position.lat, location.position.lng) ||
            "UNK"
          : "UNK",
        lat: location?.position.lat ?? null,
        lng: location?.position.lng ?? null,
        locationSource: location?.source ?? "unavailable",
        placeSource: location ? placeSourceFor(location.source) : "unavailable",
        date: capturedAt,
        dateSource,
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
      const code = caught instanceof Error ? caught.message : "MODEL_ERROR";
      setError(errorMessage(code));
      if (code !== "LOCATION_NOT_FOUND" && code !== "GEOCODER_UNAVAILABLE") {
        setShowManual(true);
      }
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
      setLoadingStage("");
    }
  }

  async function submitVideo(file: File) {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    setLoadingStage("正在拆出画面和声音");
    setError("");
    setShowManual(false);

    try {
      const extracted = await extractFramesAndAudio(file);
      setLoadingStage("正在听你说，也在看画面");
      const requestBody = {
        frames: extracted.frames,
        audioDataUrl: extracted.audioDataUrl,
        history: items.map(toHistoryEntry),
        placeFallback: place.trim() || null,
      };
      if (jsonByteLength(requestBody) > MAX_AV_REQUEST_BYTES) {
        throw new AvExtractionError(
          "REQUEST_TOO_LARGE",
          "视频拆包后的请求仍然太大",
        );
      }
      const response = await fetch("/api/encounter-av", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const failed = payload as { code?: string };
        throw new Error(failed.code ?? "MODEL_ERROR");
      }
      const result = avResponseSchema.parse(payload);
      if (!result.recognized) {
        setError("这段视频里没有找到清晰的对象，可以换个角度或说得更具体一点。");
        return;
      }
      setAvDraft(
        createAvDraft(
          {
            ...result,
            segments: result.segments.map((segment) => ({
              ...segment,
              nameEn: segment.nameEn ?? undefined,
            })),
          },
          extracted.frames,
          items,
          file.lastModified,
          place,
          extracted.truncated,
          location
            ? {
                place: place.trim() || "当前位置",
                country:
                  country ||
                  detectCountryFromPosition(location.position.lat, location.position.lng) ||
                  "UNK",
                lat: location.position.lat,
                lng: location.position.lng,
                source: location.source,
              }
            : null,
        ),
      );
    } catch (caught) {
      const code =
        caught instanceof AvExtractionError
          ? caught.code
          : caught instanceof Error
            ? caught.message
            : "MODEL_ERROR";
      setError(errorMessage(code));
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
      setLoadingStage("");
    }
  }

  async function saveManual() {
    if (savingManual) return;
    if (locationLoading || !preview || !manualName.trim()) {
      setError("手动保存至少需要照片和名称。");
      return;
    }
    setSavingManual(true);
    try {
      const now = new Date().toISOString();
      const item: Item = {
        id: nanoid(),
        name: manualName.trim(),
        category: manualCategory,
        photo: preview,
        place: location ? place.trim() || "当前位置" : "?",
        country: location
          ? country ||
            detectCountryFromPosition(location.position.lat, location.position.lng) ||
            "UNK"
          : "UNK",
        lat: location?.position.lat ?? null,
        lng: location?.position.lng ?? null,
        locationSource: location?.source ?? "unavailable",
        placeSource: location ? placeSourceFor(location.source) : "unavailable",
        dateSource,
        date: capturedAt,
        userNote: userNote.trim(),
        ai: null,
        isSeed: false,
        createdAt: now,
      };
      await db.items.put(item);
      router.push(`/item/${item.id}`);
    } catch {
      setError(errorMessage("LOCAL_STORAGE_ERROR"));
    } finally {
      setSavingManual(false);
    }
  }

  if (avDraft) {
    return (
      <AvConfirm
        draft={avDraft}
        history={items}
        onCancel={() => setAvDraft(null)}
      />
    );
  }

  if (textMode) {
    return (
      <TextEncounter
        initialPlace={place}
        initialCountry={country}
        coordinate={
          location
            ? {
                lat: location.position.lat,
                lng: location.position.lng,
                source: location.source,
              }
            : null
        }
        onCancel={() => setTextMode(false)}
      />
    );
  }
  return (
    <main className={`app-shell ${styles.encounterShell}`}>
      <div className={`phone-page ${styles.encounterPage}`}>
        <header className={`page-header ${styles.encounterHeader}`}>
          <button className="icon-action" onClick={() => router.back()} aria-label="返回">
            <ArrowLeft size={18} />
          </button>
          <div className="brand-lockup">
            <h1>新增发现</h1>
            <span>显影一件遇见</span>
          </div>
          <Sparkles size={18} color="var(--teal)" />
        </header>

        <div className={`form-stack ${styles.encounterForm}`}>
          <section className="form-card surface">
            <p className="eyebrow">01 / 已选画面</p>
            {preview ? (
              <div className="photo-preview">
                <img src={preview} alt="待显影的照片" />
              </div>
            ) : videoFile ? (
              <div className="video-selected">
                <FileVideo2 size={28} />
                <strong>视频已选</strong>
                <span>{videoFile.name} · 最长 60 秒 / 100MB</span>
              </div>
            ) : (
              <div className="empty-state">请返回首页，通过滑块选择拍摄或相册。</div>
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
            {!locationLoading && location ? (
              <div className={`status-note ${location.source === "default" ? "warning" : ""}`} style={{ marginTop: 12 }}>
                {location.source === "gps" || location.source === "exif" ? <Check size={15} /> : <MapPin size={15} />}
                <span>
                  {geocodeLoading
                    ? "正在自动识别地点…"
                    : `${location.text}${place ? ` · ${place}` : ""}`}
                </span>
              </div>
            ) : !locationLoading ? (
              <div className="status-note warning" style={{ marginTop: 12 }}>
                <MapPin size={15} />
                <span>暂未识别地点，保存后可在详情页补充。</span>
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
            disabled={loading || geocodeLoading || locationLoading}
          >
            <Sparkles size={19} />
            {loading
              ? loadingStage || "AI记录中…"
              : geocodeLoading
                ? "正在校准地点…"
                : locationLoading && !videoFile
                  ? "正在确认位置…"
                  : "AI记录"}
          </button>
          {error && !showManual ? (
            <button
              className="secondary-action"
              onClick={() => void submit()}
              disabled={loading || geocodeLoading || locationLoading}
            >
              <RotateCcw size={17} />
              重试
            </button>
          ) : null}
          <p className="privacy-note">
            照片，或视频中抽取的画面帧和音频，只在识别期间临时发送给百炼模型；原视频与应用服务端都不会保存这些内容。地点名称会发送给 OpenStreetMap 地点服务用于校准坐标，查询结果会在服务端缓存。
          </p>
        </div>
      </div>
      <AppNav />
      {loading ? (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-inner">
            <div className="loading-orb" />
            <strong>{loadingStage || "正在看这张照片…"}</strong>
            <span>让一件遇见慢慢显出名字，也看看我们是否早就见过。</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}
