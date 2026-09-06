"use client";

import {
  Camera,
  ChevronRight,
  CircleHelp,
  Download,
  FolderOpen,
  ImagePlus,
  Plus,
  RefreshCw,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { setPendingEncounterFile } from "@/lib/encounter-transfer";
import {
  DEFAULT_OSC_BASE_URL,
  isSecureContextForOsc,
  normalizeOscBaseUrl,
  oscGetState,
  oscListFiles,
  oscStartCapture,
  oscStopCapture,
  oscTakePicture,
  oscWaitForCapture,
  type OscFileEntry,
} from "@/lib/osc";
import styles from "./devices.module.css";

type DemoDevice = {
  name: string;
  image?: string;
  photos: number;
  videos: number;
  pending: string;
  battery: number;
};

const X6_DEMO: DemoDevice = {
  name: "Insta360 X6",
  photos: 0,
  videos: 0,
  pending: "WiFi 直连",
  battery: 0,
};

export default function DevicesPage() {
  const router = useRouter();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [device] = useState<DemoDevice | null>(X6_DEMO);
  const [autoSync, setAutoSync] = useState(true);
  const [notice, setNotice] = useState("");
  const [oscBaseUrl, setOscBaseUrl] = useState(DEFAULT_OSC_BASE_URL);
  const [oscBusy, setOscBusy] = useState(false);
  const [oscStatus, setOscStatus] = useState("");
  const [latestFiles, setLatestFiles] = useState<OscFileEntry[]>([]);

  function showNotice(message = "设备连接功能正在准备中") {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  }

  function importInsta360File(file: File | undefined) {
    if (!file) return;
    setPendingEncounterFile(file, "insta360");
    router.push("/encounter?source=insta360");
  }

  function oscError(error: unknown) {
    if (isSecureContextForOsc()) {
      return "HTTPS 页面会被浏览器拦截 HTTP 相机请求，请改用局域网 HTTP 地址或原生壳。";
    }
    return error instanceof Error ? error.message : "OSC 请求失败";
  }

  async function handleOscState() {
    setOscBusy(true);
    setOscStatus("");
    try {
      const state = await oscGetState(oscBaseUrl);
      setOscStatus(`已连接：${state.fingerprint || state.state || "相机在线"}`);
    } catch (error) {
      setOscStatus(oscError(error));
    } finally {
      setOscBusy(false);
    }
  }

  async function handleOscCapture() {
    setOscBusy(true);
    setOscStatus("已发送拍照指令，等待完成…");
    try {
      await oscTakePicture(oscBaseUrl);
      const state = await oscWaitForCapture(oscBaseUrl);
      setOscStatus(state._latestFileUrl ? `拍摄完成：${state._latestFileUrl}` : "拍摄完成");
    } catch (error) {
      setOscStatus(oscError(error));
    } finally {
      setOscBusy(false);
    }
  }

  async function handleOscStartCapture() {
    setOscBusy(true);
    setOscStatus("正在开始录像…");
    try {
      await oscStartCapture(oscBaseUrl);
      setOscStatus("已开始录像");
    } catch (error) {
      setOscStatus(oscError(error));
    } finally {
      setOscBusy(false);
    }
  }

  async function handleOscStopCapture() {
    setOscBusy(true);
    setOscStatus("正在停止录像…");
    try {
      await oscStopCapture(oscBaseUrl);
      setOscStatus("已停止录像");
    } catch (error) {
      setOscStatus(oscError(error));
    } finally {
      setOscBusy(false);
    }
  }

  async function handleOscListFiles() {
    setOscBusy(true);
    setOscStatus("");
    try {
      const files = await oscListFiles(oscBaseUrl);
      setLatestFiles(files);
      setOscStatus(files.length ? `读取到 ${files.length} 个文件` : "相机里暂时没有文件");
    } catch (error) {
      setOscStatus(oscError(error));
    } finally {
      setOscBusy(false);
    }
  }

  async function importLatestOscFile(fileUrl?: string) {
    if (!fileUrl) {
      setOscStatus("请先读取文件列表。");
      return;
    }
    setOscBusy(true);
    setOscStatus("正在从相机拉取文件…");
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`文件拉取失败：${response.status}`);
      const blob = await response.blob();
      const name = fileUrl.split("/").pop() || `x6-${Date.now()}.jpg`;
      const type = blob.type || (name.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
      const file = new File([blob], name, { type });
      setPendingEncounterFile(file, "insta360");
      router.push("/encounter?source=insta360&osc=1");
    } catch (error) {
      setOscStatus(oscError(error));
      setOscBusy(false);
    }
  }

  return (
    <main className={`app-shell ${styles.deviceShell}`}>
      <div className={`phone-page ${styles.devicePage}`}>
        <header className={styles.deviceHeader}>
          <div>
            <h1>设备集</h1>
            <p>让旅途的影像，自动成为永恒的收藏</p>
          </div>
          <button className={styles.helpButton} onClick={() => showNotice("设备使用说明正在准备中")} aria-label="设备帮助">
            <CircleHelp size={24} strokeWidth={1.7} />
          </button>
        </header>

        <section className={styles.deviceCard} aria-label="当前设备状态">
          <div className={styles.deviceSummary}>
            {device ? (
              device.image ? (
                <img className={styles.devicePhoto} src={device.image} alt={device.name} />
              ) : (
                <div className={styles.cameraIllustration} aria-hidden="true">
                  <Camera size={46} strokeWidth={1.25} />
                  <span />
                </div>
              )
            ) : (
              <div className={styles.cameraIllustration} aria-hidden="true">
                <Camera size={46} strokeWidth={1.25} />
                <span />
              </div>
            )}
            {device ? (
              <div>
                <span className={styles.deviceEyebrow}>INSTA360 X6 · 360°</span>
                <h2>{device.name}</h2>
                <p className={styles.connectedStatus}><span /> WiFi 热点直连已就绪 <em><Wifi size={13} /> 相册导入</em></p>
                <small>手机连接 X6 热点后，网页直接控制快门与录像</small>
              </div>
            ) : (
              <div>
                <span className={styles.deviceEyebrow}>YOUR CAMERA</span>
                <h2>尚未连接设备</h2>
                <p><WifiOff size={14} /> 等待第一次连接</p>
                <small>支持 GoPro、DJI、Insta360 等设备</small>
              </div>
            )}
          </div>
          <div className={styles.deviceStats}>
            <span><strong>{device?.photos || "—"}</strong><small>360 照片</small></span>
            <span><strong>{device?.videos || "—"}</strong><small>360 视频</small></span>
            <span><strong>{device?.pending ?? "—"}</strong><small>待同步</small></span>
          </div>
        </section>

        <section className={styles.deviceSettings} aria-label="设备设置预览">
          <div className={styles.settingsRow}>
            <span className={styles.settingsIcon}><RefreshCw size={17} /></span>
            <span><strong>自动同步</strong><small>连接 Wi-Fi 后自动同步影像</small></span>
            <button className={`${styles.switch} ${autoSync ? styles.on : ""}`} onClick={() => setAutoSync((value) => !value)} aria-pressed={autoSync} aria-label="自动同步">
              <span />
            </button>
          </div>
          <button className={styles.settingsRow} onClick={() => importInputRef.current?.click()}>
            <span className={styles.settingsIcon}><ImagePlus size={17} /></span>
            <span><strong>导入 360 照片</strong><small>从 Insta360 App 导出到手机相册后，点击选择</small></span>
            <ChevronRight size={18} />
          </button>
          <button className={styles.settingsRow} onClick={() => showNotice()}>
            <span className={styles.settingsIcon}><FolderOpen size={17} /></span>
            <span><strong>存储管理</strong><small>{device ? "查看设备与同步空间" : "连接设备后管理同步空间"}</small></span>
            <ChevronRight size={18} />
          </button>
          <button className={styles.settingsRow} onClick={() => showNotice()}>
            <span className={styles.settingsIcon}><Settings size={17} /></span>
            <span><strong>设备设置</strong><small>相机参数与偏好设置</small></span>
            <ChevronRight size={18} />
          </button>
        </section>

        <section className={styles.oscPanel} aria-label="OSC WiFi 控制">
          <div className={styles.oscHeader}>
            <div>
              <span className={styles.deviceEyebrow}>OSC CONTROL</span>
              <h2>WiFi 拍摄控制</h2>
              <small>手机连接 X6 热点后，直接触发快门、读取状态和最新文件。</small>
            </div>
            <Wifi size={20} color="var(--teal)" />
          </div>
          <label className={styles.oscField}>
            <span>相机地址</span>
            <input
              value={oscBaseUrl}
              onChange={(event) => setOscBaseUrl(event.target.value)}
              placeholder={DEFAULT_OSC_BASE_URL}
              inputMode="url"
            />
          </label>
          <div className={styles.oscActions}>
            <button className="secondary-action" onClick={() => void handleOscState()} disabled={oscBusy}>
              <Wifi size={16} />
              状态
            </button>
            <button className="secondary-action" onClick={() => void handleOscCapture()} disabled={oscBusy}>
              <Camera size={16} />
              拍摄
            </button>
            <button className="secondary-action" onClick={() => void handleOscStartCapture()} disabled={oscBusy}>
              <Camera size={16} />
              录像
            </button>
            <button className="secondary-action" onClick={() => void handleOscStopCapture()} disabled={oscBusy}>
              <RefreshCw size={16} />
              停止
            </button>
            <button className="secondary-action" onClick={() => void handleOscListFiles()} disabled={oscBusy}>
              <RefreshCw size={16} />
              文件
            </button>
          </div>
          {latestFiles.length ? (
            <div className={styles.oscFiles}>
              {latestFiles.slice(0, 3).map((file, index) => (
                <button
                  key={file.fileUrl || index}
                  onClick={() => void importLatestOscFile(file.fileUrl)}
                  disabled={oscBusy}
                >
                  <Download size={14} />
                  {file.name || `文件 ${index + 1}`}
                </button>
              ))}
            </div>
          ) : null}
          {oscStatus ? <p className="share-status">{oscStatus}</p> : null}
        </section>

        <button className={styles.connectDevice} onClick={() => showNotice()}>
          <span><Plus size={19} strokeWidth={1.8} /></span>
          <strong>连接新设备</strong>
          <small>连上 X6 WiFi 热点后，网页直接控制相机</small>
        </button>
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          importInsta360File(file);
          event.target.value = "";
        }}
      />
      <AppNav />
      {notice ? <div className="toast">{notice}</div> : null}
    </main>
  );
}