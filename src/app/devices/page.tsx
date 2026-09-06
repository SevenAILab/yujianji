"use client";

import { Camera, ChevronRight, FolderOpen, Plus, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AppNav } from "@/components/AppNav";
import { db, ensureSeeded } from "@/lib/db";
import { CAMERA_ADDRESS, cameraError, connectInsta360, disconnectInsta360, openCameraWifiSettings, openInsta360App, useInsta360 } from "@/lib/insta360";
import { HealthDevices } from "./HealthDevices";
import styles from "./devices.module.css";

export default function DevicesPage() {
  const device = useInsta360();
  useEffect(() => { void ensureSeeded().catch(() => setError("示例照片加载失败，请刷新重试。")); }, []);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState(CAMERA_ADDRESS);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [storageOpen, setStorageOpen] = useState(false);
  const photoCount = useLiveQuery(async () => {
    try { return await db.items.filter((item) => item.mediaKind === "panorama" && !!item.photo).count(); }
    catch { return null; }
  }, []);

  async function connect() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError("");
    try { await connectInsta360(address); setAdding(false); }
    catch (error) { setError(cameraError(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  return <main className={`app-shell ${styles.deviceShell}`}>
    <div className={`phone-page ${styles.devicePage}`}>
      <header className={styles.deviceHeader}><div><h1>设备集</h1><p>连接健康数据，收藏旅途影像</p></div></header>
      <section className={styles.deviceCard} aria-label="Insta360 设备">
        <div className={styles.deviceSummary}>
          <div className={styles.cameraIllustration} aria-hidden="true"><Camera size={46} strokeWidth={1.25} /><span /></div>
          <div><span className={styles.deviceEyebrow}>INSTA360 · 360°</span><h2>{device?.name || "添加你的全景相机"}</h2>
            <p className={device ? styles.connectedStatus : undefined}>{device && <span />}{device ? "已连接 · Wi-Fi" : "尚未连接"}</p>
            <small>{device ? "首页拍摄中已加入 Insta360 相机" : "连接相机后，在首页发起全景拍摄"}</small>
          </div>
        </div>
        <div className={styles.panoramaCount}><strong>{photoCount ?? "—"}</strong><span>张全景照片<small>本应用中的全景照片 · 含示例</small></span></div>
        {photoCount === null && <p className={styles.hardwareError} role="alert">暂时无法读取本地照片数量，请刷新重试。</p>}
        {device && <div className={styles.hardwareActions}><button className={styles.hardwareButton} disabled={busy} onClick={() => void connect()}>检查连接</button><button className={styles.hardwareButton} disabled={busy} onClick={disconnectInsta360}>断开设备</button></div>}
      </section>
      {!device && <button className={styles.connectDevice} onClick={() => { setAdding(true); setError(""); }}><span><Plus size={19} /></span><strong>添加新设备</strong><small>连接 Insta360 相机 Wi-Fi</small></button>}
      {adding && <section className={styles.hardwareCard} aria-label="添加 Insta360" aria-busy={busy}>
        <div className={styles.hardwareHeader}><h2>连接相机</h2><Wifi size={22} /></div>
        <p className={styles.hardwareNote}>打开相机 Wi-Fi，在手机系统的 Wi-Fi 设置中选择相机热点。连接后返回这里，点击「检查并连接」。</p>
        <p className={styles.hardwareNote}>网页不能自动切换 Wi-Fi；请允许原生 App 访问本地网络。</p>
        <label className={styles.oscField}><span>相机地址</span><input value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)} inputMode="url" /></label>
        <div className={styles.hardwareActions}><button className={styles.hardwareButton} disabled={busy} onClick={() => void openCameraWifiSettings().catch((error) => setError(cameraError(error)))}>打开 Wi-Fi 设置</button><button className={`${styles.hardwareButton} ${styles.connectButton}`} disabled={busy} onClick={() => void connect()}>{busy ? "正在连接…" : "检查并连接"}</button><button className={styles.hardwareButton} disabled={busy} onClick={() => setAdding(false)}>取消</button></div>
      </section>}
      {error && <p className={styles.hardwareError} role="alert">{error}</p>}
      <section className={styles.deviceSettings} aria-label="相机管理">
        <button className={styles.settingsRow} onClick={() => { setStorageOpen(true); void openInsta360App().catch((error) => setError(cameraError(error))); }}><span className={styles.settingsIcon}><FolderOpen size={17} /></span><span><strong>存储管理</strong><small>在 Insta360 App 中管理相机存储</small></span><ChevronRight size={18} /></button>
        {storageOpen && <div className={styles.storageHelp}><p className={styles.hardwareNote}>请打开 Insta360 App，连接相机后进入相册管理。当前尚无经过验证的存储页直达链接。</p><a href="https://www.insta360.com/download/insta360-app" target="_blank" rel="noreferrer">获取 Insta360 App</a></div>}
      </section>
      <HealthDevices />
    </div><AppNav />
  </main>;
}
