"use client";

import { Camera, Globe2, ImagePlus, PenLine, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { InsightLine } from "@/components/InsightLine";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { MemoryGlobe, type MemoryGlobeApiPin, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { db, ensureSeeded } from "@/lib/db";
import { setPendingEncounterFile } from "@/lib/encounter-transfer";
import type { Item } from "@/lib/types";
import styles from "./home.module.css";

export default function Home() {
  const router = useRouter();
  const [seedReady, setSeedReady] = useState(false);
  const [mapResetToken, setMapResetToken] = useState(0);
  const [mapPins, setMapPins] = useState<MemoryGlobePin[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);
  const captureSliderRef = useRef<HTMLDivElement>(null);
  const captureStartXRef = useRef(0);
  const captureDragRef = useRef(0);
  const captureDraggingRef = useRef(false);
  const captureTouchActiveRef = useRef(false);
  const [captureDrag, setCaptureDrag] = useState(0);
  const [captureDragging, setCaptureDragging] = useState(false);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );
  const [toast, setToast] = useState("");

  async function beginFileEncounter(
    file: File | undefined,
    source: "camera" | "album",
  ) {
    if (!file) return;
    setToast(source === "camera" ? "正在准备拍摄内容…" : "正在读取相册内容…");
    await setPendingEncounterFile(file, source);
    router.push("/encounter");
  }

  function openFilePicker(input: HTMLInputElement | null) {
    if (!input) return;
    input.value = "";
    input.click();
  }

  function handleSelectedFile(
    event: ReactChangeEvent<HTMLInputElement>,
    source: "camera" | "album",
  ) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void beginFileEncounter(file, source);
  }

  function captureSliderLimit() {
    return 54;
  }

  function startCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "touch") return;
    captureStartXRef.current = event.clientX;
    captureDragRef.current = 0;
    captureDraggingRef.current = true;
    setCaptureDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "touch") return;
    if (!captureDraggingRef.current) return;
    const limit = captureSliderLimit();
    const next = Math.max(-limit, Math.min(limit, event.clientX - captureStartXRef.current));
    captureDragRef.current = next;
    setCaptureDrag(next);
  }

  function completeCaptureDrag(completedDrag: number) {
    const limit = captureSliderLimit();
    const threshold = limit * .58;
    captureDraggingRef.current = false;
    setCaptureDragging(false);
    setCaptureDrag(0);
    captureDragRef.current = 0;
    if (completedDrag >= threshold) openFilePicker(albumInputRef.current);
    if (completedDrag <= -threshold) openFilePicker(photoInputRef.current);
  }

  function finishCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "touch") return;
    const completedDrag = captureDragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    completeCaptureDrag(completedDrag);
  }

  function cancelCaptureDrag() {
    captureDraggingRef.current = false;
    captureDragRef.current = 0;
    setCaptureDragging(false);
    setCaptureDrag(0);
  }

  function startCaptureTouch(event: ReactTouchEvent<HTMLButtonElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    captureTouchActiveRef.current = true;
    captureStartXRef.current = touch.clientX;
    captureDragRef.current = 0;
    captureDraggingRef.current = true;
    setCaptureDragging(true);
  }

  function moveCaptureTouch(event: ReactTouchEvent<HTMLButtonElement>) {
    if (!captureTouchActiveRef.current) return;
    const touch = event.touches[0];
    if (!touch) return;
    event.preventDefault();
    const limit = captureSliderLimit();
    const next = Math.max(
      -limit,
      Math.min(limit, touch.clientX - captureStartXRef.current),
    );
    captureDragRef.current = next;
    setCaptureDrag(next);
  }

  function finishCaptureTouch() {
    if (!captureTouchActiveRef.current) return;
    captureTouchActiveRef.current = false;
    completeCaptureDrag(captureDragRef.current);
  }

  function cancelCaptureTouch() {
    captureTouchActiveRef.current = false;
    cancelCaptureDrag();
  }

  useEffect(() => {
    if (!items.length) {
      setMapPins([]);
      return;
    }
    let active = true;
    fetch("/api/map-pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: items.map(({ photo: _photo, ai: _ai, ...item }) => item),
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("map pins failed");
        return response.json() as Promise<{
          pins: MemoryGlobeApiPin[];
        }>;
      })
      .then((result) => {
        if (!active) return;
        setMapPins(result.pins.map((pin) => ({
          ...pin,
          coverPhoto: items.find((item) => item.id === pin.coverItemId)?.photo ?? "",
          locations: pin.locations.map((location) => ({
            ...location,
            coverPhoto: items.find((item) => item.id === location.coverItemId)?.photo ?? "",
          })),
        })));
      })
      .catch(() => {
        if (active) setToast("地图地点暂时无法加载，请稍后重试。");
      });
    return () => { active = false; };
  }, [items]);

  useEffect(() => {
    let active = true;
    ensureSeeded()
      .then((inserted) => {
        if (active && inserted) {
          setToast("已载入示例历史。照片来自队员的真实旅行记录。");
          window.setTimeout(() => setToast(""), 3600);
        }
      })
      .catch(() => {
        if (active) setToast("示例历史加载失败，请刷新重试。");
      })
      .finally(() => {
        if (active) setSeedReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => {
    const firsts = items.filter((item) => item.ai?.verdict === "first");
    const locations = new Set(
      items
        .filter((item) => item.lat !== null && item.lng !== null)
        .map((item) => `${item.country}:${item.place.trim()}:${item.lat}:${item.lng}`),
    );
    return {
      discovered: items.length,
      countries: new Set(
        items
          .filter((item) => item.country !== "UNK" && item.country !== "OTHER")
          .map((item) => item.country),
      ).size,
      firsts: firsts.length,
      locations: locations.size,
    };
  }, [items]);

  return (
    <main className={`app-shell ${styles.homeShell}`}>
      <div className={`phone-page ${styles.homePage}`}>
        <header className={styles.heroHeader}>
          <div>
            <p className={styles.wordmark}>遇见集<sup>®</sup></p>
            <p className={styles.subtitle}>THE PLACES THAT MADE ME</p>
            <p className={styles.tagline}>世界很大，而你，正好出发。</p>
          </div>
          <button
            className={styles.globeReset}
            aria-label="重置地图视角"
            title="重置地图视角"
            onClick={() => setMapResetToken((token) => token + 1)}
          >
            <Globe2 size={26} strokeWidth={1.8} />
          </button>
        </header>

        <div className={styles.globeStage}>
          <MapErrorBoundary>
            <MemoryGlobe key={mapResetToken} pins={mapPins} />
          </MapErrorBoundary>
        </div>

        <section className={styles.dashboard} aria-label="开始一次遇见">
          <div className={styles.captureSlider}>
            <div className={`${styles.captureSliderRail} ${captureDragging ? styles.active : ""}`} ref={captureSliderRef}>
              <span className={styles.captureSliderLine} />
              <div className={styles.captureSliderLabels}>
                <label htmlFor="home-camera-input">
                  <Camera size={18} strokeWidth={1.7} />拍摄
                </label>
                <label htmlFor="home-album-input">
                  相册<ImagePlus size={17} strokeWidth={1.7} />
                </label>
              </div>
              <button
                className={`${styles.captureSliderThumb} ${captureDragging ? styles.dragging : ""}`}
                style={{ transform: `translateX(${captureDrag}px)` }}
                type="button"
                role="slider"
                aria-label="向左滑动拍摄，向右滑动打开相册"
                aria-valuemin={-100}
                aria-valuemax={100}
                aria-valuenow={Math.round((captureDrag / captureSliderLimit()) * 100)}
                onPointerDown={startCaptureDrag}
                onPointerMove={moveCaptureDrag}
                onPointerUp={finishCaptureDrag}
                onPointerCancel={(event) => {
                  if (event.pointerType !== "touch") cancelCaptureDrag();
                }}
                onTouchStart={startCaptureTouch}
                onTouchMove={moveCaptureTouch}
                onTouchEnd={finishCaptureTouch}
                onTouchCancel={cancelCaptureTouch}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") openFilePicker(photoInputRef.current);
                  if (event.key === "ArrowRight") openFilePicker(albumInputRef.current);
                }}
              >
                <Plus size={24} strokeWidth={1.8} />
              </button>
            </div>
            <p>左滑拍摄&nbsp;&nbsp;·&nbsp;&nbsp;右滑相册</p>
            <input
              id="home-camera-input"
              ref={photoInputRef}
              className="file-input"
              type="file"
              accept="image/*,video/*"
              capture="environment"
              onChange={(event) => handleSelectedFile(event, "camera")}
            />
            <input
              id="home-album-input"
              ref={albumInputRef}
              className="file-input"
              type="file"
              accept="image/*,video/*"
              onChange={(event) => handleSelectedFile(event, "album")}
            />
          </div>

          <button className={styles.textEncounter} onClick={() => router.push("/encounter?mode=text")}>
            <PenLine size={15} />
            没有照片？只写字也可以记住这一刻
          </button>

          <div className={styles.stats} aria-label="遇见统计">
            <div><strong>{stats.discovered}</strong><span>已遇见</span></div>
            <div><strong>{stats.firsts}</strong><span>第一次</span></div>
            <div><strong>{stats.countries}</strong><span>国家</span></div>
            <div><strong>{stats.locations}</strong><span>地点</span></div>
          </div>

          <div className={styles.insight}><InsightLine items={items} /></div>
        </section>
      </div>
      <AppNav />
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
