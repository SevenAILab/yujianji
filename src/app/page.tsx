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
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { InsightLine } from "@/components/InsightLine";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { MemoryGlobe, type MemoryGlobeApiPin, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { db, ensureSeeded } from "@/lib/db";
import { setPendingEncounterFile } from "@/lib/encounter-transfer";
import { hydrateMapPins } from "@/lib/local-map-pins";
import { usePageZoomLock } from "@/lib/use-page-zoom-lock";
import type { Item } from "@/lib/types";
import { cameraError, captureInsta360, useInsta360 } from "@/lib/insta360";
import styles from "./home.module.css";

export default function Home() {
  const router = useRouter();
  const insta360 = useInsta360();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const cameraLock = useRef(false);
  const cameraPageActive = useRef(true);
  useEffect(() => {
    cameraPageActive.current = true;
    return () => { cameraPageActive.current = false; };
  }, []);
  async function shootInsta360() {
    if (cameraLock.current) return;
    cameraLock.current = true;
    setCameraBusy(true);
    try {
      const file = await captureInsta360((message) => { if (cameraPageActive.current) setToast(message); });
      if (!cameraPageActive.current) return;
      await setPendingEncounterFile(file, "insta360");
      setPickerOpen(false);
      router.push("/encounter?source=insta360");
    } catch (error) { if (cameraPageActive.current) setToast(cameraError(error)); }
    finally { cameraLock.current = false; if (cameraPageActive.current) setCameraBusy(false); }
  }
  function openCamera() {
    if (insta360) setPickerOpen(true);
    else openFilePicker(photoInputRef.current);
  }
  usePageZoomLock();
  const [seedReady, setSeedReady] = useState(false);
  const [mapResetToken, setMapResetToken] = useState(0);
  const [mapPins, setMapPins] = useState<MemoryGlobePin[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);
  const openedByDragRef = useRef(false);
  const captureSliderRef = useRef<HTMLDivElement>(null);
  const cameraLabelRef = useRef<HTMLLabelElement>(null);
  const albumLabelRef = useRef<HTMLLabelElement>(null);
  const captureStartXRef = useRef(0);
  const captureDragRef = useRef(0);
  const captureDraggingRef = useRef(false);
  const captureTargetRef = useRef<"camera" | "album" | null>(null);
  const [captureDrag, setCaptureDrag] = useState(0);
  const [captureDragging, setCaptureDragging] = useState(false);
  const [captureTarget, setCaptureTarget] = useState<"camera" | "album" | null>(null);
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

  function captureSliderBounds() {
    const rail = captureSliderRef.current?.getBoundingClientRect();
    const camera = cameraLabelRef.current?.getBoundingClientRect();
    const album = albumLabelRef.current?.getBoundingClientRect();
    if (!rail || !camera || !album) return { left: -54, right: 54 };
    const railCenter = rail.left + rail.width / 2;
    return {
      left: camera.left + camera.width / 2 - railCenter,
      right: album.left + album.width / 2 - railCenter,
    };
  }

  function setSliderTarget(target: "camera" | "album" | null) {
    if (captureTargetRef.current === target) return;
    captureTargetRef.current = target;
    setCaptureTarget(target);
  }

  function startCaptureDrag(event: ReactPointerEvent<HTMLLabelElement>) {
    captureStartXRef.current = event.clientX;
    captureDragRef.current = 0;
    captureDraggingRef.current = true;
    setSliderTarget(null);
    event.currentTarget.htmlFor = "";
    setCaptureDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCaptureDrag(event: ReactPointerEvent<HTMLLabelElement>) {
    if (!captureDraggingRef.current) return;
    const bounds = captureSliderBounds();
    const next = Math.max(bounds.left, Math.min(bounds.right, event.clientX - captureStartXRef.current));
    captureDragRef.current = next;
    setCaptureDrag(next);
    if (next <= bounds.left * .78) setSliderTarget("camera");
    else if (next >= bounds.right * .78) setSliderTarget("album");
    else setSliderTarget(null);
  }

  function completeCaptureDrag(completedDrag: number) {
    const bounds = captureSliderBounds();
    const cameraThreshold = bounds.left * .78;
    const albumThreshold = bounds.right * .78;
    captureDraggingRef.current = false;
    setCaptureDragging(false);
    setCaptureDrag(0);
    captureDragRef.current = 0;
    const target = completedDrag >= albumThreshold
      ? "album"
      : completedDrag <= cameraThreshold
        ? "camera"
        : null;
    setSliderTarget(target);
    return target;
  }

  function finishCaptureDrag(event: ReactPointerEvent<HTMLLabelElement>) {
    const completedDrag = captureDragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = completeCaptureDrag(completedDrag);
    // 触屏上，一旦拖动超过浏览器的 slop 阈值，pointerup 之后就不会再补发 click，
    // 所以靠 <label htmlFor> 去触发 file input 在手机上必然失效（鼠标端却能用，
    // 因为 click 会落在 down/up 的共同祖先上，与拖动距离无关）。
    // pointerup 处理函数本身就在用户手势上下文里，直接 .click() 在 iOS Safari 上可用。
    if (target) {
      event.currentTarget.htmlFor = "";
      openedByDragRef.current = true;
      if (target === "camera") openCamera();
      else openFilePicker(albumInputRef.current);
      return;
    }
    // Keep the system picker for an ordinary tap; a connected camera adds a choice.
    if (insta360) {
      event.currentTarget.htmlFor = "";
      openedByDragRef.current = true;
      setPickerOpen(true);
    } else {
      event.currentTarget.htmlFor = "home-album-input";
      openedByDragRef.current = false;
    }
  }

  function cancelCaptureDrag() {
    captureDraggingRef.current = false;
    captureDragRef.current = 0;
    setSliderTarget(null);
    setCaptureDragging(false);
    setCaptureDrag(0);
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
        setMapPins(hydrateMapPins(result.pins, items));
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
                <label ref={cameraLabelRef} htmlFor="home-camera-input" onClick={(event) => { if (insta360) { event.preventDefault(); setPickerOpen(true); } }}>
                  <Camera size={18} strokeWidth={1.7} />拍摄
                </label>
                <label ref={albumLabelRef} htmlFor="home-album-input">
                  相册<ImagePlus size={17} strokeWidth={1.7} />
                </label>
              </div>
              <label
                htmlFor={captureTarget === "camera" ? "home-camera-input" : captureTarget === "album" ? "home-album-input" : undefined}
                className={`${styles.captureSliderThumb} ${captureDragging ? styles.dragging : ""}`}
                style={{ transform: `translateX(${captureDrag}px)` }}
                role="slider"
                tabIndex={0}
                data-target={captureTarget ?? undefined}
                aria-label="向左滑动拍摄，向右滑动打开相册"
                aria-valuemin={-100}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  captureDrag < 0
                    ? (captureDrag / Math.abs(captureSliderBounds().left)) * 100
                    : (captureDrag / captureSliderBounds().right) * 100,
                )}
                onPointerDown={startCaptureDrag}
                onPointerMove={moveCaptureDrag}
                onPointerUp={finishCaptureDrag}
                onPointerCancel={cancelCaptureDrag}
                onClick={(event) => {
                  // 拖动那条路已经程序化打开过了，拦掉 label 的默认行为，
                  // 否则鼠标端会连开两次；轻点则必须放行，交给系统面板。
                  if (openedByDragRef.current) event.preventDefault();
                  window.setTimeout(() => setSliderTarget(null), 0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") openCamera();
                  if (event.key === "ArrowRight") openFilePicker(albumInputRef.current);
                }}
              >
                <Plus size={24} strokeWidth={1.8} />
              </label>
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

      {pickerOpen ? (
        <div
          className="picker-sheet-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPickerOpen(false);
          }}
        >
          <section className="picker-sheet" role="dialog" aria-modal="true" aria-label="选择记录方式">
            <h2>记下这一刻</h2>
            {/* 必须是真正的 <label htmlFor>，由用户自己点击。
                iOS Safari 只认这条路径，程序化 .click() 会被吞。 */}
            <label htmlFor="home-camera-input" onClick={() => setPickerOpen(false)}>
              <Camera size={18} strokeWidth={1.7} />
              <span>拍照 / 录像</span>
            </label>
            {insta360 && <button className="insta360-capture-option" disabled={cameraBusy} onClick={() => void shootInsta360()}><Camera size={18} strokeWidth={1.7} /><span>{cameraBusy ? "正在拍摄全景…" : "Insta360 · 全景拍照"}</span></button>}
            <label htmlFor="home-album-input" onClick={() => setPickerOpen(false)}>
              <ImagePlus size={18} strokeWidth={1.7} />
              <span>从相册选择</span>
            </label>
            <button className="picker-sheet-cancel" onClick={() => setPickerOpen(false)}>取消</button>
          </section>
        </div>
      ) : null}

      <AppNav />
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
