"use client";

import { Camera, Globe2, ImagePlus, PenLine, Plus, Video } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  const videoInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);
  const captureSliderRef = useRef<HTMLDivElement>(null);
  const captureStartXRef = useRef(0);
  const captureDragRef = useRef(0);
  const captureDraggingRef = useRef(false);
  const capturePressTimerRef = useRef<number | null>(null);
  const captureLongPressRef = useRef(false);
  const recordingReleaseRequestedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingClockRef = useRef<number | null>(null);
  const recordingLimitRef = useRef<number | null>(null);
  const recordingVideoRef = useRef<HTMLVideoElement>(null);
  const [captureDrag, setCaptureDrag] = useState(0);
  const [captureDragging, setCaptureDragging] = useState(false);
  const [recordingState, setRecordingState] = useState<"idle" | "preparing" | "recording">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );
  const [toast, setToast] = useState("");

  function beginFileEncounter(file: File | undefined, source: "camera" | "album") {
    if (!file) return;
    setPendingEncounterFile(file, source);
    router.push("/encounter");
  }

  function captureSliderLimit() {
    return 54;
  }

  function clearCapturePressTimer() {
    if (capturePressTimerRef.current !== null) {
      window.clearTimeout(capturePressTimerRef.current);
      capturePressTimerRef.current = null;
    }
  }

  function clearRecordingTimers() {
    if (recordingClockRef.current !== null) window.clearInterval(recordingClockRef.current);
    if (recordingLimitRef.current !== null) window.clearTimeout(recordingLimitRef.current);
    recordingClockRef.current = null;
    recordingLimitRef.current = null;
  }

  function closeRecordingStream() {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    if (recordingVideoRef.current) recordingVideoRef.current.srcObject = null;
  }

  function stopVideoRecording() {
    recordingReleaseRequestedRef.current = true;
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }

  async function startVideoRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      videoInputRef.current?.click();
      return;
    }

    recordingReleaseRequestedRef.current = false;
    setRecordingState("preparing");
    setRecordingSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true,
      });
      if (recordingReleaseRequestedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingState("idle");
        return;
      }

      recordingStreamRef.current = stream;
      if (recordingVideoRef.current) {
        recordingVideoRef.current.srcObject = stream;
        void recordingVideoRef.current.play();
      }
      const supportedType = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        clearRecordingTimers();
        closeRecordingStream();
        recorderRef.current = null;
        setRecordingState("idle");
        setToast("录像没有保存成功，请重新长按拍摄。");
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || supportedType || "video/webm";
        const blob = new Blob(recordingChunksRef.current, { type: mimeType });
        const extension = mimeType.includes("mp4") ? "mp4" : "webm";
        clearRecordingTimers();
        closeRecordingStream();
        recorderRef.current = null;
        setRecordingState("idle");
        if (!blob.size) {
          setToast("录像时间太短，请稍微多按一会儿。");
          return;
        }
        beginFileEncounter(
          new File([blob], `encounter-${Date.now()}.${extension}`, { type: mimeType }),
          "camera",
        );
      };
      recorder.start(250);
      recordingStartedAtRef.current = Date.now();
      setRecordingState("recording");
      recordingClockRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.max(1, Math.ceil((Date.now() - recordingStartedAtRef.current) / 1000)));
      }, 200);
      recordingLimitRef.current = window.setTimeout(stopVideoRecording, 60_000);
    } catch {
      clearRecordingTimers();
      closeRecordingStream();
      recorderRef.current = null;
      setRecordingState("idle");
      setToast("需要允许相机和麦克风权限，才能长按录像。");
    }
  }

  function startCapturePress(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    captureLongPressRef.current = false;
    recordingReleaseRequestedRef.current = false;
    clearCapturePressTimer();
    capturePressTimerRef.current = window.setTimeout(() => {
      captureLongPressRef.current = true;
      void startVideoRecording();
    }, 520);
  }

  function finishCapturePress(event: ReactPointerEvent<HTMLButtonElement>) {
    clearCapturePressTimer();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (captureLongPressRef.current) stopVideoRecording();
    else photoInputRef.current?.click();
  }

  function cancelCapturePress() {
    clearCapturePressTimer();
    if (captureLongPressRef.current) stopVideoRecording();
  }

  function startCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    captureStartXRef.current = event.clientX;
    captureDragRef.current = 0;
    captureDraggingRef.current = true;
    setCaptureDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!captureDraggingRef.current) return;
    const limit = captureSliderLimit();
    const next = Math.max(-limit, Math.min(limit, event.clientX - captureStartXRef.current));
    captureDragRef.current = next;
    setCaptureDrag(next);
  }

  function finishCaptureDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const limit = captureSliderLimit();
    const threshold = limit * .58;
    const completedDrag = captureDragRef.current;
    captureDraggingRef.current = false;
    setCaptureDragging(false);
    setCaptureDrag(0);
    captureDragRef.current = 0;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (completedDrag >= threshold) albumInputRef.current?.click();
    if (completedDrag <= -threshold) photoInputRef.current?.click();
  }

  function cancelCaptureDrag() {
    captureDraggingRef.current = false;
    captureDragRef.current = 0;
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
      items.map((item) => `${item.country}:${item.place.trim()}:${item.lat ?? ""}:${item.lng ?? ""}`),
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
                <button
                  type="button"
                  aria-label="点按拍照，长按录像"
                  onPointerDown={startCapturePress}
                  onPointerUp={finishCapturePress}
                  onPointerCancel={cancelCapturePress}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <Camera size={18} strokeWidth={1.7} />拍摄
                </button>
                <span>相册<ImagePlus size={17} strokeWidth={1.7} /></span>
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
                onPointerCancel={cancelCaptureDrag}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") photoInputRef.current?.click();
                  if (event.key === "ArrowRight") albumInputRef.current?.click();
                }}
              >
                <Plus size={24} strokeWidth={1.8} />
              </button>
            </div>
            <p>点按拍照&nbsp;&nbsp;·&nbsp;&nbsp;长按录像&nbsp;&nbsp;·&nbsp;&nbsp;右滑相册</p>
            <input
              ref={photoInputRef}
              className="file-input"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => beginFileEncounter(event.target.files?.[0], "camera")}
            />
            <input
              ref={videoInputRef}
              className="file-input"
              type="file"
              accept="video/*"
              capture="environment"
              onChange={(event) => beginFileEncounter(event.target.files?.[0], "camera")}
            />
            <input
              ref={albumInputRef}
              className="file-input"
              type="file"
              accept="image/*,video/*"
              onChange={(event) => beginFileEncounter(event.target.files?.[0], "album")}
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
      {recordingState !== "idle" ? (
        <div className={styles.recordingOverlay} aria-live="polite">
          <video ref={recordingVideoRef} muted playsInline />
          <div>
            <Video size={18} />
            <strong>{recordingState === "preparing" ? "正在打开相机…" : `录像中 ${recordingSeconds}s`}</strong>
            <span>{recordingState === "recording" ? "松手结束并进入 AI 记录" : "请继续按住"}</span>
          </div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
