"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, ArrowUpRight, Bluetooth, HeartPulse, ShieldCheck, Smartphone, Watch, RefreshCw } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/db";
import { getHealthBridge, latestSample, nativePlatform, parseNativeSamples, type HealthMetric } from "@/lib/native-bridge";
import { saveHealthSamples } from "@/lib/health-sync";
import { riskLevelForHealth } from "@/lib/trip";
import "./devices.css";

const brands = [
  { name: "华为 HUAWEI", app: "华为运动健康", mark: "H", text: "需确认当前机型、地区及 App 是否支持共享至系统健康平台；不支持时需华为授权 SDK。" },
  { name: "华米 Amazfit", app: "Zepp", mark: "A", text: "先在 Zepp 绑定手表，并检查系统健康数据共享选项。同步类型取决于型号与版本。" },
  { name: "小米 Xiaomi", app: "小米运动健康 / Mi Fitness", mark: "mi", text: "先在厂商 App 完成同步，检查心率、血氧、步数是否实际写入系统健康平台。" },
];
const metrics: { key: HealthMetric; name: string; unit: string }[] = [
  { key: "heartRate", name: "心率", unit: "bpm" },
  { key: "bloodOxygen", name: "血氧", unit: "%" },
  { key: "steps", name: "区间步数", unit: "步" },
];

export default function DevicesPage() {
  const [platform, setPlatform] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState(0);
  const [origin, setOrigin] = useState("");
  const [now, setNow] = useState(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const stored = useLiveQuery(() => db.healthSamples.orderBy("timestamp").reverse().toArray(), [], []);
  const origins = [...new Map(stored.map((sample) => [sample.originId, sample.originName || sample.originId])).entries()];
  const filtered = stored.filter((sample) => !origin || sample.originId === origin);

  useEffect(() => {
    mounted.current = true;
    setPlatform(nativePlatform());
    setNow(Date.now());
    const bridge = getHealthBridge();
    if (bridge) void bridge.status().then((status) => {
      if (!mounted.current) return;
      setAvailable(status.available);
      if (!status.available) setMessage(status.reason || "系统健康服务不可用");
    }).catch(() => { if (mounted.current) setMessage("原生插件未注册或不可用，请检查 App 构建。"); });
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  async function sync() {
    const bridge = getHealthBridge();
    if (!bridge) { setMessage("当前是网页预览。请在 Android / iOS 原生 App 中授权，网页不能读取手表私有健康数据。"); return; }
    if (!consent || operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage("");
    try {
      const access = await bridge.requestAccess();
      if (!mounted.current) return;
      if (!access.requested || (access.granted && access.granted.length === 0)) throw new Error("未授予读取权限，没有同步任何数据。");
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const result = await bridge.readSamples({ from, to });
      if (!mounted.current) return;
      const samples = parseNativeSamples(result.samples, from, to);
      const count = await saveHealthSamples(samples);
      setNow(Date.now());
      setMessage(samples.length
        ? `同步完成：新增 ${count} 条，读取 ${samples.length} 条。${result.truncated ? "记录达到上限，结果不完整。" : "重复记录已去重。"}来源以系统返回为准，并不代表所选品牌已连接。`
        : "没有可读取记录：可能未授权、厂商尚未同步或该指标不支持。iOS 不披露读取权限是否被拒绝，不能把空结果判为授权成功。");
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "同步失败，请检查系统健康权限。");
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function clearImported() {
    if (!window.confirm("删除本机所有原生健康导入记录（含行程中的导入快照）？已导出的文件不受影响。系统权限需到健康 App 撤销。")) return;
    try {
      await db.transaction("rw", db.healthSamples, db.trips, async () => {
        await db.healthSamples.clear();
        await db.trips.toCollection().modify((trip) => {
          trip.healthSnapshots = trip.healthSnapshots.filter((snapshot) => snapshot.source !== "health-provider");
          trip.riskLevel = riskLevelForHealth(trip.healthSnapshots);
        });
      });
      setConsent(false);
      setMessage("本机导入记录已删除。请在系统健康设置中撤销遇见集的权限；已导出文件需自行删除。");
    } catch { setMessage("删除失败，请检查浏览器存储后重试。"); }
  }

  return (
    <main className="app-shell device-shell">
      <div className="phone-page device-page">
        <header className="device-header"><Link href="/" aria-label="返回地图"><ArrowLeft size={21} /></Link><h1>连接新设备</h1><ShieldCheck size={21} /></header>
        <p className="device-subtitle">把身体的状态，带进每一段遇见。</p>
        <section className="device-radar-section">
          <div className="device-radar"><Watch size={29} strokeWidth={1.4} /></div>
          <h2>{platform ? "连接你的系统健康平台" : "你的户外设备伙伴"}</h2>
          <p>{platform ? `${platform === "android" ? "Health Connect" : "Apple HealthKit"} · ${available ? "可请求读取" : "等待确认"}` : "网页预览 · 真实数据需在原生 App 中授权"}</p>
        </section>

        <section aria-label="手表品牌接入指引" className="device-brands">
          {brands.map((brand, index) => <button key={brand.name} className={`device-brand ${selected === index ? "selected" : ""}`} onClick={() => setSelected(index)} aria-pressed={selected === index}>
            <span className="device-brand-mark">{brand.mark}</span><span><strong>{brand.name}</strong><small>{brand.app}</small></span><span className="device-status-tag">接入指引</span>
          </button>)}
        </section>

        <section className="device-guide" aria-label="连接说明">
          <h2>从 {brands[selected].app} 开始</h2>
          <p>{brands[selected].text}</p>
          <ol><li>在厂商 App 绑定手表并完成同步</li><li>在系统健康平台确认数据及来源</li><li>在遇见集原生 App 授权并读取记录</li></ol>
          <p>选择品牌只切换指引，不表示发现或连接了该设备。无需重新蓝牙配对。</p>
        </section>

        <label className="device-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>同意读取最近 24 小时心率、血氧与步数，仅保存在本机并关联进行中的行程，不自动上传 AI。可随时删除。</span>
        </label>
        <button className="primary-action device-sync" disabled={busy || (Boolean(platform) && (!available || !consent))} onClick={() => void sync()}><RefreshCw size={17} />{busy ? "正在读取健康记录…" : platform ? "授权并同步健康数据" : "查看原生接入方式"}</button>
        {message ? <p role="status" className="device-message">{message}</p> : null}

        <section className="device-data">
          <div className="device-section-head"><h2><HeartPulse size={19} />身体状态</h2><span>{stored.length} 条本地记录</span></div>
          {origins.length ? <label className="device-source-filter">数据来源<select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">全部来源（不合并计步）</option>{origins.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label> : null}
          <div className="device-vitals">{metrics.map((metric) => {
            const sample = latestSample(filtered, metric.key, now);
            const stale = sample && now - Date.parse(sample.timestamp) > 300_000;
            return <div key={metric.key}><span>{metric.name}</span><strong>{sample ? Math.round(sample.value) : "—"}<small>{metric.unit}</small></strong><small>{sample ? `${stale ? "历史记录 · " : "采样于 "}${new Date(sample.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "等待授权与同步"}</small><small className="device-origin">{sample?.originName}</small></div>;
          })}</div>
          <p className="device-data-note">缺失值不补零。步数是单条记录区间值，不是全天总数；不同来源不相加。同步数据非实时监护，也不能用于判定路线安全。</p>
          {stored.length ? <button className="device-delete" disabled={busy} onClick={() => void clearImported()}>删除本机导入记录</button> : null}
        </section>
        <Link className="device-footer-link" href="/trip"><Bluetooth size={18} /><span>标准蓝牙心率 / 手动记录<small>仍可在行程中使用</small></span><ArrowUpRight size={18} /></Link>
        <p className="device-platform-note"><Smartphone size={14} />原生工程已提供 · 品牌与真机兼容性待验证</p>
      </div>
      <AppNav />
    </main>
  );
}
