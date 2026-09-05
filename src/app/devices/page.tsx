"use client";

import {
  Camera,
  ChevronRight,
  CircleHelp,
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
  pending: "手机中继",
  battery: 0,
};

export default function DevicesPage() {
  const router = useRouter();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [device] = useState<DemoDevice | null>(X6_DEMO);
  const [autoSync, setAutoSync] = useState(true);
  const [notice, setNotice] = useState("");

  function showNotice(message = "设备连接功能正在准备中") {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  }

  function importInsta360File(file: File | undefined) {
    if (!file) return;
    setPendingEncounterFile(file, "insta360");
    router.push("/encounter?source=insta360");
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
                <p className={styles.connectedStatus}><span /> 手机中继已就绪 <em><Wifi size={13} /> 相册导入</em></p>
                <small>通过 Insta360 App 导出 360 照片，手机作为中继站导入遇见集</small>
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

        <button className={styles.connectDevice} onClick={() => showNotice()}>
          <span><Plus size={19} strokeWidth={1.8} /></span>
          <strong>连接新设备</strong>
          <small>当前使用手机中继，不需要直连相机</small>
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
