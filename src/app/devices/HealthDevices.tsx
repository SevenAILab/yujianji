"use client";

import { Bluetooth, Heart } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectStandardHeartRate, supportsStandardBluetooth, type DeviceConnection } from "@/lib/devices";
import { getHealthBridge, latestSample, parseNativeSamples, type HealthBridgePlugin, type HealthMetric, type NativeHealthSample } from "@/lib/native-bridge";
import { saveHealthSamples } from "@/lib/health-sync";
import type { HealthSnapshot } from "@/lib/types";
import styles from "./devices.module.css";

type Status = Awaited<ReturnType<HealthBridgePlugin["status"]>>;
const metrics: { key: HealthMetric; label: string; unit: string }[] = [
  { key: "heartRate", label: "心率", unit: "次/分" },
  { key: "bloodOxygen", label: "血氧", unit: "%" },
  { key: "steps", label: "步数（最近一段）", unit: "步" },
];
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const timeText = (value: string) => new Date(value).toLocaleString("zh-CN");

export function HealthDevices() {
  const [status, setStatus] = useState<Status | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [healthNote, setHealthNote] = useState("");
  const [requested, setRequested] = useState(false);
  const [samples, setSamples] = useState<NativeHealthSample[]>([]);
  const [bluetoothSupported, setBluetoothSupported] = useState(false);
  const [bluetoothState, setBluetoothState] = useState("正在检查支持情况");
  const [bluetoothBusy, setBluetoothBusy] = useState(false);
  const [bluetoothError, setBluetoothError] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const alive = useRef(false);
  const healthLock = useRef(false);
  const bluetoothLock = useRef(false);
  const connection = useRef<DeviceConnection | null>(null);
  const attempt = useRef(0);

  const checkStatus = useCallback(async () => {
    if (healthLock.current) return;
    healthLock.current = true;
    setHealthBusy(true);
    setHealthError("");
    // A return from Settings may have revoked access; do not retain stale readings.
    setSamples([]);
    setHealthNote("");
    try {
      const bridge = getHealthBridge();
      const next = bridge ? await bridge.status() : { available: false, provider: "healthkit" as const, reason: "请在 iOS 或 Android 原生 App 中使用健康数据；网页不支持。" };
      if (alive.current) setStatus(next);
    } catch (error) {
      if (alive.current) { setStatus(null); setHealthError(errorText(error)); }
    } finally {
      healthLock.current = false;
      if (alive.current) setHealthBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const supported = supportsStandardBluetooth();
    setBluetoothSupported(supported);
    setBluetoothState(supported ? "未连接" : "当前环境不支持");
    void checkStatus();
    const onVisible = () => { if (document.visibilityState === "visible") void checkStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      attempt.current += 1;
      connection.current?.disconnect();
      connection.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkStatus]);

  async function readHealth(authorize: boolean) {
    const bridge = getHealthBridge();
    if (!bridge || healthLock.current) return;
    healthLock.current = true;
    setHealthBusy(true);
    setHealthError("");
    setHealthNote("");
    setSamples([]);
    try {
      const next = await bridge.status();
      if (!alive.current) return;
      setStatus(next);
      if (!next.available) return;
      if (authorize) {
        const access = await bridge.requestAccess();
        if (!alive.current) return;
        setRequested(access.requested);
        setStatus({ ...next, granted: access.granted });
        if (!access.requested || access.granted?.length === 0) {
          setHealthNote("未获得读取权限，请重新授权或在系统健康设置中开启。");
          return;
        }
      }
      const to = new Date().toISOString();
      const from = new Date(Date.parse(to) - 86_400_000).toISOString();
      const result = await bridge.readSamples({ from, to });
      const parsed = parseNativeSamples(result.samples, from, to);
      if (!alive.current) return;
      setSamples(parsed);
      setHealthNote(parsed.length ? `${result.truncated ? "仅返回部分记录；" : ""}已读取最近 24 小时数据。` : "最近 24 小时暂无可读取数据，请检查授权及手表同步状态。");
      try {
        await saveHealthSamples(parsed);
      } catch {
        if (alive.current) setHealthError("数据已读取，但本地保存失败，请重试。");
      }
    } catch (error) {
      if (alive.current) setHealthError(errorText(error));
    } finally {
      healthLock.current = false;
      if (alive.current) setHealthBusy(false);
    }
  }

  async function connectBluetooth() {
    if (bluetoothLock.current || connection.current) return;
    bluetoothLock.current = true;
    const current = ++attempt.current;
    const active = () => alive.current && current === attempt.current;
    setBluetoothBusy(true);
    setBluetoothError("");
    setSnapshot(null);
    setBluetoothState("正在搜索 / 连接，请选择心率设备");
    try {
      const next = await connectStandardHeartRate(
        (value) => { if (active()) setSnapshot(value); },
        () => {
          if (!active()) return;
          connection.current = null;
          setDeviceName("");
          setSnapshot(null);
          setBluetoothState("设备已断开，请重新连接");
        },
      );
      if (!active()) { next.disconnect(); return; }
      connection.current = next;
      setDeviceName(next.label);
      setBluetoothState("已连接");
    } catch (error) {
      if (!active()) return;
      const cancelled = error instanceof Error && error.name === "NotFoundError";
      setBluetoothState(cancelled ? "未选择设备，可重新搜索" : "连接失败");
      if (!cancelled) setBluetoothError(errorText(error));
    } finally {
      bluetoothLock.current = false;
      if (active()) setBluetoothBusy(false);
    }
  }

  function disconnectBluetooth() {
    attempt.current += 1;
    connection.current?.disconnect();
    connection.current = null;
    setDeviceName("");
    setSnapshot(null);
    setBluetoothState("已断开");
  }

  const authorization = !status?.available ? "不可用" : status.granted == null
    ? requested ? "已请求授权；系统不返回读取权限结果" : "读取权限未确认"
    : status.granted.length === 3 ? "已授权" : status.granted.length ? "部分授权" : "未授权";

  return <>
    <section className={styles.hardwareCard} aria-label="手机健康数据" aria-busy={healthBusy}>
      <div className={styles.hardwareHeader}><div><span className={styles.deviceEyebrow}>HEALTH</span><h2>{status?.available ? status.provider === "healthkit" ? "Apple Health · HealthKit" : "Android · Health Connect" : "手机健康数据"}</h2></div><Heart size={24} /></div>
      <p className={styles.hardwareNote} role="status">{healthBusy ? "正在处理健康数据…" : status ? `授权状态：${authorization}` : "尚未取得健康服务状态"}</p>
      {status && !status.available && <p className={styles.hardwareNote}>{status.reason || "此设备的健康服务不可用。"}</p>}
      {status?.available && <>
        <div className={styles.healthMetrics}>
          {metrics.map(({ key, label, unit }) => {
            const sample = latestSample(samples, key);
            return <div key={key}><span>{label}</span><strong>{sample ? `${sample.value} ${unit}` : "—"}</strong><small>{status.granted ? status.granted.includes(key) ? "已授权" : "未授权" : "读取权限由系统管理"}</small>{sample && <small>{timeText(sample.timestamp)}{sample.endTimestamp ? ` 至 ${timeText(sample.endTimestamp)}` : ""}<br />{sample.originName}</small>}</div>;
          })}
        </div>
        <p className={styles.hardwareNote}>显示各项最新记录；步数为单条记录的区间步数，不是今日总步数。空值不代表 0。</p>
        {status.provider === "healthkit" && <p className={styles.hardwareNote}>iOS 不披露读取权限是否获准；无数据也可能是未授权。请在系统健康设置中查看或撤销权限。</p>}
        <div className={styles.hardwareActions}>
          <button className={styles.hardwareButton} disabled={healthBusy} onClick={() => void readHealth(true)}>授权并读取</button>
          <button className={styles.hardwareButton} disabled={healthBusy} onClick={() => void readHealth(false)}>刷新数据</button>
        </div>
      </>}
      <button className={styles.statusButton} disabled={healthBusy} onClick={() => void checkStatus()}>重新检查状态</button>
      {healthNote && <p className={styles.hardwareNote} role="status">{healthNote}</p>}
      {healthError && <p className={styles.hardwareError} role="alert">{healthError}</p>}
    </section>
    <section className={styles.hardwareCard} aria-label="蓝牙心率设备" aria-busy={bluetoothBusy}>
      <div className={styles.hardwareHeader}><div><span className={styles.deviceEyebrow}>BLUETOOTH</span><h2>{deviceName || "蓝牙心率设备"}</h2></div><Bluetooth size={24} /></div>
      <p className={styles.hardwareNote} role="status">{bluetoothState}</p>
      <p className={styles.liveHeartRate}>{snapshot?.heartRate ?? "—"}<small> 次/分</small></p>
      <p className={styles.hardwareNote}>{snapshot ? `最近收到：${timeText(snapshot.timestamp)}` : deviceName ? "等待设备发送心率数据…" : "仅支持提供标准 heart_rate 服务的设备。"}</p>
      {!bluetoothSupported && <p className={styles.hardwareNote}>请使用支持 Web Bluetooth 的浏览器，并通过 HTTPS 或 localhost 访问。当前浏览器或原生 WebView 可能不提供此能力。</p>}
      <div className={styles.hardwareActions}>
        <button className={`${styles.hardwareButton} ${styles.connectButton}`} disabled={!bluetoothSupported || bluetoothBusy || !!deviceName} onClick={() => void connectBluetooth()}>{bluetoothBusy ? "正在连接…" : "搜索并连接"}</button>
        <button className={styles.hardwareButton} disabled={!deviceName} onClick={disconnectBluetooth}>断开连接</button>
      </div>
      <p className={styles.hardwareNote}>退出设备页将断开蓝牙连接；最后接收时间可用于判断数据是否仍在更新。</p>
      {bluetoothError && <p className={styles.hardwareError} role="alert">{bluetoothError}</p>}
    </section>
  </>;
}
