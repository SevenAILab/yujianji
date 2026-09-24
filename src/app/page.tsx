"use client";

import { Camera, FolderInput, ImagePlus, Mic, Sparkles, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { InsightLine } from "@/components/InsightLine";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { useRecorder } from "@/components/memo/RecorderProvider";
import { MemoryGlobe, type MemoryGlobeApiPin, type MemoryGlobePin } from "@/components/MemoryGlobe";
import { db, ensureSeeded, loadDemoData } from "@/lib/db";
import { setPendingEncounterFile } from "@/lib/encounter-transfer";
import { isAudioFile, setPendingMemoImport } from "@/lib/memo/client/import-handoff";
import { hydrateMapPins } from "@/lib/local-map-pins";
import { usePageZoomLock } from "@/lib/use-page-zoom-lock";
import type { Item } from "@/lib/types";
import { cameraError, captureInsta360, useInsta360 } from "@/lib/insta360";
import styles from "./home.module.css";
import { apiFetch } from "@/lib/api-client";

export default function Home() {
  const router = useRouter();
  const heroHeaderRef = useRef<HTMLElement>(null);
  const taglineRef = useRef<HTMLParagraphElement>(null);
  const universeEntryRef = useRef<HTMLAnchorElement>(null);
  const [heroConnector, setHeroConnector] = useState<{
    width: number;
    height: number;
    startX: number;
    startY: number;
    elbowX: number;
    targetX: number;
    targetY: number;
  } | null>(null);
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
  usePageZoomLock();
  const [seedReady, setSeedReady] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [mapPins, setMapPins] = useState<MemoryGlobePin[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);
  const items = useLiveQuery(
    () => (seedReady ? db.items.orderBy("date").toArray() : Promise.resolve([] as Item[])),
    [seedReady],
    [],
  );
  const [toast, setToast] = useState("");
  const recorder = useRecorder();
  const recorderBusy = recorder.recording.phase === "recording" || recorder.recording.phase === "stopping";

  async function beginFileEncounter(
    file: File | undefined,
    source: "camera" | "album",
  ) {
    if (!file) return;
    setToast(source === "camera" ? "正在准备拍摄内容…" : "正在读取相册内容…");
    await setPendingEncounterFile(file, source);
    router.push("/encounter");
  }

  /** 首页「导入」：照片、视频走遇见流程；录音交给导入页确认时间地点 */
  async function handleImportFile(event: ReactChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!isAudioFile(file)) {
      await beginFileEncounter(file, "album");
      return;
    }
    if (!recorder.enabled) {
      setToast("离线本地版不能处理录音，只能导入照片。");
      return;
    }
    setToast("正在读取录音…");
    try {
      await setPendingMemoImport(file);
      router.push("/memo/import?from=home");
    } catch {
      setToast("这个浏览器存不下这段录音，请到「导入录音」页直接选择。");
    }
  }

  function handleSelectedFile(
    event: ReactChangeEvent<HTMLInputElement>,
    source: "camera" | "album",
  ) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void beginFileEncounter(file, source);
  }


  useEffect(() => {
    if (!items.length) {
      setMapPins([]);
      return;
    }
    let active = true;
    apiFetch("/api/map-pins", {
        items: items.map(({ photo: _photo, ai: _ai, ...item }) => item),
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
        // 示例刷新失败不打扰用户：个人记录不受影响。
      })
      .finally(() => {
        if (active) setSeedReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // 统计和洞察只算你自己的记录，和「我的」页同一个口径；示例单独说明
  const mine = useMemo(() => items.filter((item) => !item.isSeed), [items]);
  const stats = useMemo(() => {
    const firsts = mine.filter((item) => item.ai?.verdict === "first");
    const locations = new Set(
      mine
        .filter((item) => item.lat !== null && item.lng !== null)
        .map((item) => `${item.country}:${item.place.trim()}:${item.lat}:${item.lng}`),
    );
    return {
      discovered: mine.length,
      countries: new Set(
        mine
          .filter((item) => item.country !== "UNK" && item.country !== "OTHER")
          .map((item) => item.country),
      ).size,
      firsts: firsts.length,
      locations: locations.size,
    };
  }, [mine]);

  useLayoutEffect(() => {
    const updateConnector = () => {
      const header = heroHeaderRef.current;
      const tagline = taglineRef.current;
      const entry = universeEntryRef.current;
      if (!header || !tagline || !entry) return;
      const headerRect = header.getBoundingClientRect();
      const taglineRect = tagline.getBoundingClientRect();
      const entryRect = entry.getBoundingClientRect();
      const textGap = Number.parseFloat(window.getComputedStyle(tagline).fontSize) || 15;
      const startX = taglineRect.right - headerRect.left + textGap;
      const startY = taglineRect.top - headerRect.top + taglineRect.height / 2;
      const targetX = entryRect.left - headerRect.left + 10;
      const targetY = entryRect.top - headerRect.top + entryRect.height * 0.9;
      setHeroConnector({
        width: headerRect.width,
        height: headerRect.height,
        startX,
        startY,
        elbowX: Math.max(startX + 28, targetX - 26),
        targetX,
        targetY,
      });
    };
    updateConnector();
    const header = heroHeaderRef.current;
    const observer = typeof ResizeObserver === "undefined" || !header
      ? null
      : new ResizeObserver(updateConnector);
    if (observer && header) {
      observer.observe(header);
      if (taglineRef.current) observer.observe(taglineRef.current);
      if (universeEntryRef.current) observer.observe(universeEntryRef.current);
    }
    window.addEventListener("resize", updateConnector);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateConnector);
    };
  }, []);

  return (
    <main className={`app-shell ${styles.homeShell}`}>
      <div className={`phone-page ${styles.homePage}`}>
        <header ref={heroHeaderRef} className={styles.heroHeader}>
          <div>
            <p className={styles.wordmark}>遇见集<sup>®</sup></p>
            <p className={styles.subtitle}>A COLLECTION OF ENCOUNTERS</p>
            <p ref={taglineRef} className={styles.tagline}>每一次新的遇见，都是一个人精神图景的扩张</p>
          </div>
          <div className={styles.headerActions}>
            {/* 精神图景入口：评委不一定会去捏合地球，这里给一个看得见、带字的门 */}
            <Link ref={universeEntryRef} className={styles.universeEntry} href="/universe" aria-label="进入精神图景">
              <Sparkles size={18} strokeWidth={1.9} />
              <span>进入图景</span>
            </Link>
          </div>
          {heroConnector ? (
            <svg
              className={styles.annotationLine}
              viewBox={`0 0 ${heroConnector.width} ${heroConnector.height}`}
              aria-hidden="true"
              focusable="false"
            >
              <path
                d={`M ${heroConnector.startX} ${heroConnector.startY} H ${heroConnector.elbowX} L ${heroConnector.targetX} ${heroConnector.targetY}`}
              />
              <circle cx={heroConnector.startX} cy={heroConnector.startY} r="3" />
            </svg>
          ) : null}
        </header>

        <div className={styles.globeStage}>
          <MapErrorBoundary>
            <MemoryGlobe pins={mapPins} />
          </MapErrorBoundary>
        </div>

        <section className={styles.dashboard} aria-label="开始一次遇见">
          <div className={styles.captureActions}>
            {/* 拍摄、导入必须是用户亲手点的 <label htmlFor>：iOS Safari 只认这条路径，程序化 .click() 会被吞 */}
            <label
              htmlFor="home-camera-input"
              className={styles.captureAction}
              onClick={(event) => {
                if (insta360) {
                  event.preventDefault();
                  setPickerOpen(true);
                }
              }}
            >
              <Camera size={20} strokeWidth={1.7} />
              <span>拍摄</span>
            </label>
            {recorder.enabled ? (
              <button
                type="button"
                className={`${styles.captureAction} ${recorderBusy ? styles.captureActionRecording : ""}`}
                onClick={() => void (recorderBusy ? recorder.stop() : recorder.start())}
                disabled={recorder.recording.phase === "starting" || recorder.recording.phase === "stopping"}
                aria-pressed={recorderBusy}
              >
                {recorderBusy ? <Square size={18} strokeWidth={1.9} /> : <Mic size={20} strokeWidth={1.7} />}
                <span>{recorder.recording.phase === "starting" ? "准备中" : recorderBusy ? "停止" : "录音"}</span>
              </button>
            ) : null}
            <label htmlFor="home-import-input" className={styles.captureAction}>
              <FolderInput size={20} strokeWidth={1.7} />
              <span>导入</span>
            </label>
          </div>
          {/* 没有照片时的兜底：保留能力，只降一级 */}
          <Link className={styles.textEntry} href="/encounter?mode=text">
            没有照片？写几句也行
          </Link>
          <div className={styles.captureInputs}>
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
            <input
              id="home-import-input"
              className="file-input"
              type="file"
              accept="image/*,video/*,audio/*,.m4a,.mp3,.wav,.aac"
              onChange={(event) => void handleImportFile(event)}
            />
          </div>

          {seedReady && items.length === 0 ? (
            <div className={styles.onboarding}>
              <p>
                这张地图现在是空的。
                <br />
                拍下今天看到的任何一样东西 —— 一片叶子、一杯咖啡、一只路过的猫。
              </p>
              <button
                className={styles.demoLink}
                disabled={loadingDemo}
                onClick={() => {
                  setLoadingDemo(true);
                  void loadDemoData()
                    .then((count) => setToast(`已载入 ${count} 条示例，可以在「我的」页移除。`))
                    .catch(() => setToast("示例加载失败，请检查网络后重试。"))
                    .finally(() => setLoadingDemo(false));
                }}
              >
                {loadingDemo ? "正在载入…" : "还是先看看别人的遇见集"}
              </button>
            </div>
          ) : (
            <>
              <div className={styles.stats} aria-label="遇见统计">
                <div><strong>{stats.discovered}</strong><span>已遇见</span></div>
                <div><strong>{stats.firsts}</strong><span>第一次</span></div>
                <div><strong>{stats.countries}</strong><span>国家</span></div>
                <div><strong>{stats.locations}</strong><span>地点</span></div>
              </div>

              <div className={styles.insight}>
                {mine.length ? (
                  <InsightLine items={mine} />
                ) : (
                  <p className="insight-line">每一次停下来看，都会让世界多一处与你有关的坐标。</p>
                )}
              </div>
              {!mine.length ? (
                <div className={styles.demoNote}>
                  正在看示例：英国 5 天和深圳两个周末。拍下你的第一次后，这里只算你自己的。
                  <Link href="/me">移除示例</Link>
                </div>
              ) : null}
            </>
          )}
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
