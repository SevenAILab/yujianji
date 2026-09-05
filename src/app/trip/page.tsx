"use client";

import {
  Activity,
  ArrowLeft,
  Bluetooth,
  Camera,
  Check,
  Download,
  HeartPulse,
  Import,
  MapPin,
  Pause,
  Play,
  Plus,
  Route,
  Share2,
  StopCircle,
  Upload,
  Watch,
  Waves,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/db";
import { connectStandardHeartRate, healthProviderStatus, type DeviceConnection, type DeviceKind } from "@/lib/devices";
import { formatDistance, formatDuration, riskLevelForHealth, riskMessage, summarizeTrack } from "@/lib/trip";
import { tripSchema } from "@/lib/schema";
import type { HealthSnapshot, NutritionEntry, TrackPoint, Trip } from "@/lib/types";

const initialHealth = { heartRate: "", bloodOxygen: "", steps: "", altitude: "" };

function buildTrip(title: string, point?: TrackPoint): Trip {
  return {
    id: nanoid(),
    title: title.trim() || "未命名户外行程",
    status: "active",
    startedAt: new Date().toISOString(),
    trackPoints: point ? [point] : [],
    healthSnapshots: [],
    nutrition: [],
    distanceMeters: 0,
    elevationGainMeters: 0,
    riskLevel: "low",
    createdAt: new Date().toISOString(),
  };
}

function currentTrackPoint(position: GeolocationPosition): TrackPoint {
  return {
    timestamp: new Date(position.timestamp).toISOString(),
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    altitude: position.coords.altitude ?? undefined,
    heading: position.coords.heading ?? undefined,
    speed: position.coords.speed ?? undefined,
  };
}

export default function TripPage() {
  const router = useRouter();
  const trips = useLiveQuery(() => db.trips.orderBy("createdAt").reverse().toArray(), [], []);
  const currentTrip = trips[0];
  const watchId = useRef<number | null>(null);
  const deviceConnection = useRef<DeviceConnection | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const panoramaInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [toast, setToast] = useState("");
  const [locationError, setLocationError] = useState("");
  const [health, setHealth] = useState(initialHealth);
  const [meal, setMeal] = useState("");
  const [calories, setCalories] = useState("");
  const [water, setWater] = useState("");
  const [deviceKind, setDeviceKind] = useState<DeviceKind>("standard-bluetooth");
  const [deviceName, setDeviceName] = useState("");
  const [panoramaPosition, setPanoramaPosition] = useState(50);
  const dragRef = useRef<{ x: number; position: number } | null>(null);

  const latestPoint = currentTrip?.trackPoints.at(-1);
  const latestHealth = currentTrip?.healthSnapshots.at(-1);
  const risk = currentTrip?.riskLevel ?? "low";
  const duration = currentTrip ? formatDuration(currentTrip.startedAt, currentTrip.endedAt) : "0 min";
  const providerStatus = useMemo(() => healthProviderStatus(deviceKind), [deviceKind]);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
    deviceConnection.current?.disconnect();
  }, []);


  async function persistTrip(trip: Trip) {
    const summary = summarizeTrack(trip.trackPoints);
    await db.trips.put({ ...trip, ...summary, riskLevel: riskLevelForHealth(trip.healthSnapshots) });
  }

  function startWatching(tripId: string) {
    if (!navigator.geolocation) {
      setLocationError("当前浏览器不支持定位；可以先用演示轨迹查看完整流程");
      return;
    }
    watchId.current = navigator.geolocation.watchPosition(async (position) => {
      try {
        await db.transaction("rw", db.trips, async () => {
          const trip = await db.trips.get(tripId);
          if (!trip || trip.status !== "active") return;
          const point = currentTrackPoint(position);
          const previous = trip.trackPoints.at(-1);
          if (previous && new Date(point.timestamp).getTime() - new Date(previous.timestamp).getTime() < 5_000) return;
          const trackPoints = [...trip.trackPoints, point];
          const { distanceMeters, elevationGainMeters } = summarizeTrack(trackPoints);
          await db.trips.update(tripId, { trackPoints, distanceMeters, elevationGainMeters });
        });
        setLocationError("");
      } catch { setLocationError("轨迹保存失败，请检查本机存储。"); }
    }, () => setLocationError("定位权限未开启；已保留行程，可继续手动记录或导入路线"), { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 });
  }

  async function startTrip() {
    if (currentTrip?.status === "active") return;
    const trip = buildTrip(title);
    await db.trips.put(trip);
    setTitle("");
    startWatching(trip.id);
    setToast("已开始记录行程；请保持定位权限开启");
  }

  async function pauseTrip() {
    if (!currentTrip) return;
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
    watchId.current = null;
    await db.trips.update(currentTrip.id, { status: currentTrip.status === "active" ? "paused" : "active" });
    if (currentTrip.status === "paused") startWatching(currentTrip.id);
  }

  async function stopTrip() {
    if (!currentTrip) return;
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
    watchId.current = null;
    await db.trips.update(currentTrip.id, { status: "completed", endedAt: new Date().toISOString() });
    setToast("行程已保存，可以导出或分享路线");
  }

  async function addDemoTrack() {
    const trip = currentTrip ?? buildTrip(title);
    const points: TrackPoint[] = Array.from({ length: 8 }, (_, index) => ({
      timestamp: new Date(Date.now() - (7 - index) * 60_000).toISOString(),
      lat: 22.540 + index * 0.00055,
      lng: 114.060 + index * 0.0007,
      altitude: 38 + index * 4,
      heading: 52,
      speed: 1.1,
    }));
    await persistTrip({ ...trip, status: "active", trackPoints: points });
    setToast("已载入一段演示轨迹，可继续添加健康数据");
  }

  async function addHealthSnapshot() {
    if (!currentTrip) {
      setToast("请先开始一个行程");
      return;
    }
    const snapshot: HealthSnapshot = {
      timestamp: new Date().toISOString(),
      heartRate: Number(health.heartRate) || undefined,
      bloodOxygen: Number(health.bloodOxygen) || undefined,
      steps: Number(health.steps) || undefined,
      altitude: Number(health.altitude) || latestPoint?.altitude,
      source: "manual",
    };
    await persistTrip({ ...currentTrip, healthSnapshots: [...currentTrip.healthSnapshots, snapshot] });
    setToast(snapshot.heartRate && snapshot.heartRate > 145 ? "注意：心率偏高，建议降低速度并休息" : "健康快照已写入行程");
  }

  async function addMeal() {
    if (!currentTrip || !meal.trim()) return;
    const entry: NutritionEntry = { id: nanoid(), timestamp: new Date().toISOString(), meal: meal.trim(), calories: Number(calories) || undefined, waterMl: Number(water) || undefined };
    await db.trips.update(currentTrip.id, { nutrition: [...currentTrip.nutrition, entry] });
    setMeal(""); setCalories(""); setWater(""); setToast("饮食补给已记录");
  }

  async function uploadPanorama(file: File | undefined) {
    if (!file || !currentTrip) return;
    if (!file.type.startsWith("image/")) { setToast("请选择图片格式的全景文件"); return; }
    if (file.size > 8 * 1024 * 1024) { setToast("全景预览文件请控制在 8MB 以内"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      await db.trips.update(currentTrip.id, { panorama: String(reader.result) });
      setToast("全景素材已加入当前行程");
    };
    reader.readAsDataURL(file);
  }

  async function connectDevice() {
    try {
      if (deviceKind !== "standard-bluetooth") {
        router.push("/devices");
        return;
      }
      deviceConnection.current?.disconnect();
      const connection = await connectStandardHeartRate(async (snapshot) => {
        const trip = await db.trips.get(currentTrip?.id ?? "");
        if (trip) await persistTrip({ ...trip, healthSnapshots: [...trip.healthSnapshots, snapshot] });
      });
      deviceConnection.current = connection;
      setDeviceName(connection.label);
      setToast("标准蓝牙心率设备已连接");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "设备连接失败");
    }
  }

  function exportRoute() {
    if (!currentTrip) return;
    const blob = new Blob([JSON.stringify(currentTrip, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${currentTrip.title || "遇见集路线"}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  async function importRoute(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = tripSchema.parse(JSON.parse(await file.text()));
      await db.trips.put({ ...parsed, id: nanoid(), title: `${parsed.title}（导入）`, status: "completed" });
      setToast("路线已导入，可继续分享或作为下一次行程参考");
    } catch {
      setToast("路线文件格式不正确");
    }
  }

  async function shareRoute() {
    if (!currentTrip) return;
    const text = `${currentTrip.title} · ${formatDistance(currentTrip.distanceMeters)} · 爬升 ${Math.round(currentTrip.elevationGainMeters)}m · 风险 ${currentTrip.riskLevel}`;
    if (navigator.share) await navigator.share({ title: currentTrip.title, text });
    else { await navigator.clipboard?.writeText(text); setToast("路线摘要已复制"); }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <button className="icon-action" onClick={() => router.push("/")} aria-label="返回地图"><ArrowLeft size={18} /></button>
          <div className="brand-lockup"><h1>行程安全驾驶舱</h1><span>TRIP OS</span></div>
          <Route size={20} color="var(--teal)" />
        </header>

        <button className="secondary-action full-action" onClick={() => router.push("/devices")}><Watch size={18} />打开设备与健康数据中心</button>

        {!currentTrip ? (
          <section className="surface trip-hero">
            <div className="trip-hero-orb"><MapPin size={24} /></div>
            <div><p className="eyebrow">从现在开始留下轨迹</p><h2>让风景，也带上你的状态</h2><p>定位、海拔、方向与健康快照会和照片一起保存。</p></div>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给这次行程起个名字" />
            <button className="primary-action" onClick={() => void startTrip()}><Play size={18} />开始记录行程</button>
            <button className="secondary-action" onClick={() => void addDemoTrack()}><Activity size={17} />先看演示轨迹</button>
          </section>
        ) : (
          <>
            <section className={`surface trip-status-card risk-${risk}`}>
              <div className="trip-status-head"><div><p className="eyebrow">{currentTrip.status === "completed" ? "已完成行程" : currentTrip.status === "paused" ? "行程已暂停" : "正在记录"}</p><h2>{currentTrip.title}</h2></div><span className="risk-chip">{risk === "low" ? "状态平稳" : risk === "medium" ? "需要留意" : "建议停下"}</span></div>
              <div className="trip-metric-grid"><div><strong>{formatDistance(currentTrip.distanceMeters)}</strong><span>轨迹距离</span></div><div><strong>{Math.round(currentTrip.elevationGainMeters)}m</strong><span>累计爬升</span></div><div><strong>{duration}</strong><span>行程时长</span></div></div>
              <p className="risk-copy"><HeartPulse size={15} />{currentTrip.healthSnapshots.length ? riskMessage(risk) : "暂无体征数据，无法判断身体状态或路线安全。"}</p>
              <div className="trip-actions">
                {currentTrip.status !== "completed" ? <button className="primary-action" onClick={() => void pauseTrip()}>{currentTrip.status === "active" ? <Pause size={17} /> : <Play size={17} />}{currentTrip.status === "active" ? "暂停记录" : "继续记录"}</button> : null}
                {currentTrip.status !== "completed" ? <button className="secondary-action danger-action" onClick={() => void stopTrip()}><StopCircle size={17} />结束行程</button> : null}
                <button className="secondary-action" onClick={() => void addDemoTrack()}><Activity size={17} />补一段演示轨迹</button>
              </div>
              {latestPoint ? <div className="location-strip"><MapPin size={15} />{latestPoint.lat.toFixed(4)}, {latestPoint.lng.toFixed(4)}<span>{latestPoint.altitude ? `${Math.round(latestPoint.altitude)}m 海拔` : "海拔等待定位"}</span><span>{latestPoint.heading ? `${Math.round(latestPoint.heading)}° 方位` : "方位等待定位"}</span></div> : null}
              {locationError ? <p className="status-note warning"><MapPin size={15} />{locationError}</p> : null}
            </section>

            <section className="surface feature-panel">
              <div className="section-heading compact"><h2><Watch size={18} />设备与身体状态</h2><span>可追溯</span></div>
              <div className="device-row"><select value={deviceKind} onChange={(event) => setDeviceKind(event.target.value as DeviceKind)}><option value="standard-bluetooth">标准蓝牙心率设备</option><option value="huawei">华为手表</option><option value="amazfit">华米 / Amazfit</option><option value="xiaomi">小米手表</option></select><button className="secondary-action" onClick={() => void connectDevice()}><Bluetooth size={16} />{deviceKind === "standard-bluetooth" ? "连接" : "健康同步"}</button></div>
              <p className="privacy-note">{deviceName || providerStatus.message}</p>
              <div className="health-form"><label><span>心率</span><input inputMode="numeric" value={health.heartRate} onChange={(event) => setHealth({ ...health, heartRate: event.target.value })} /><em>bpm</em></label><label><span>血氧</span><input inputMode="numeric" value={health.bloodOxygen} onChange={(event) => setHealth({ ...health, bloodOxygen: event.target.value })} /><em>%</em></label><label><span>步数</span><input inputMode="numeric" value={health.steps} onChange={(event) => setHealth({ ...health, steps: event.target.value })} /><em>步</em></label><label><span>海拔</span><input inputMode="numeric" value={health.altitude} onChange={(event) => setHealth({ ...health, altitude: event.target.value })} /><em>m</em></label></div>
              <button className="secondary-action full-action" onClick={() => void addHealthSnapshot()}><Check size={16} />保存健康快照</button>
              {latestHealth ? <div className="health-latest"><Activity size={15} />最近快照：心率 {latestHealth.heartRate ?? "—"} · 血氧 {latestHealth.bloodOxygen ?? "—"}% · {new Date(latestHealth.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div> : null}
            </section>

            <section className="surface feature-panel">
              <div className="section-heading compact"><h2><Waves size={18} />饮食与补给</h2><span>{currentTrip.nutrition.length} 条记录</span></div>
              <div className="nutrition-form"><input value={meal} onChange={(event) => setMeal(event.target.value)} placeholder="例如：午餐 / 电解质水" /><input inputMode="numeric" value={calories} onChange={(event) => setCalories(event.target.value)} placeholder="热量 kcal" /><input inputMode="numeric" value={water} onChange={(event) => setWater(event.target.value)} placeholder="饮水 ml" /><button className="secondary-action" onClick={() => void addMeal()}><Plus size={16} />记录</button></div>
              {currentTrip.nutrition.length ? <div className="nutrition-list">{currentTrip.nutrition.slice().reverse().map((entry) => <div key={entry.id}><strong>{entry.meal}</strong><span>{entry.calories ? `${entry.calories} kcal` : ""}{entry.waterMl ? ` · ${entry.waterMl} ml` : ""}</span></div>)}</div> : <p className="privacy-note">记录补给后，可以和身体状态一起回看“什么时候需要休息”。</p>}
            </section>

            <section className="surface feature-panel">
              <div className="section-heading compact"><h2><Camera size={18} />照片与全景现场</h2><span>可分享</span></div>
              <input ref={panoramaInput} className="sr-only" type="file" accept="image/*" onChange={(event) => void uploadPanorama(event.target.files?.[0])} />
              {currentTrip.panorama ? <div className="panorama-viewer" style={{ backgroundImage: `url(${currentTrip.panorama})`, backgroundPosition: `${panoramaPosition}% center` }} onPointerDown={(event) => { dragRef.current = { x: event.clientX, position: panoramaPosition }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!dragRef.current) return; const next = Math.max(0, Math.min(100, dragRef.current.position - (event.clientX - dragRef.current.x) / 3)); setPanoramaPosition(next); }} onPointerUp={() => { dragRef.current = null; }}><span>拖动查看 360° 全景</span></div> : <button className="panorama-empty" onClick={() => panoramaInput.current?.click()}><Upload size={19} />上传 Insta360 / 全景照片</button>}
              {currentTrip.panorama ? <button className="secondary-action full-action" onClick={() => panoramaInput.current?.click()}><Upload size={16} />替换全景素材</button> : null}
              <p className="privacy-note">浏览器端先支持本地 equirectangular 图片预览；Insta360 Link 2 SDK 当前是 UVC/PTZ 控制，不是全景文件编码 SDK。</p>
            </section>

            <section className="surface feature-panel">
              <div className="section-heading compact"><h2><Share2 size={18} />路线社区与设备交换</h2><span>开放格式</span></div>
              <p className="share-copy">路线 JSON 可保存轨迹、健康快照、补给和风险摘要；后续原生桥接层可把同一份路线同步到手表。</p>
              <div className="action-row"><button className="secondary-action" onClick={exportRoute}><Download size={16} />导出路线</button><button className="secondary-action" onClick={() => importInput.current?.click()}><Import size={16} />导入路线</button><button className="secondary-action" onClick={() => void shareRoute()}><Share2 size={16} />分享摘要</button></div>
              <input ref={importInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importRoute(event.target.files?.[0])} />
            </section>
          </>
        )}
      </div>
      <AppNav />
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
