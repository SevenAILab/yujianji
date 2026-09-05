"use client";

import {
  Camera,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Plus,
  RefreshCw,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { AppNav } from "@/components/AppNav";
import styles from "./devices.module.css";

type DemoDevice = {
  name: string;
  image: string;
  photos: number;
  videos: number;
  pending: string;
  battery: number;
};

const ACE_PRO_2_DEMO: DemoDevice = {
  name: "Insta360 Ace Pro 2",
  image: "/insta360-ace-pro-2.jpg",
  photos: 124,
  videos: 8,
  pending: "2.4 GB",
  battery: 80,
};

export default function DevicesPage() {
  const [device] = useState<DemoDevice | null>(ACE_PRO_2_DEMO);
  const [autoSync, setAutoSync] = useState(true);
  const [notice, setNotice] = useState("");

  function showNotice(message = "设备连接功能正在准备中") {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
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
              <img className={styles.devicePhoto} src={device.image} alt={device.name} />
            ) : (
              <div className={styles.cameraIllustration} aria-hidden="true">
                <Camera size={46} strokeWidth={1.25} />
                <span />
              </div>
            )}
            {device ? (
              <div>
                <span className={styles.deviceEyebrow}>DEMO CAMERA</span>
                <h2>{device.name}</h2>
                <p className={styles.connectedStatus}><span /> 已连接 · 演示 <em><Wifi size={13} /> {device.battery}%</em></p>
                <small>当前为界面演示，尚未接入真实设备服务</small>
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
            <span><strong>{device?.photos ?? "—"}</strong><small>照片</small></span>
            <span><strong>{device?.videos ?? "—"}</strong><small>视频</small></span>
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
          <small>设备接入服务即将开放</small>
        </button>
      </div>
      <AppNav />
      {notice ? <div className="toast">{notice}</div> : null}
    </main>
  );
}
