"use client";

import { geoDistance, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mesh } from "topojson-client";
import world from "world-atlas/countries-110m.json";

type Geometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface MemoryGlobeLocation {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  itemIds: string[];
  coverItemId: string;
  coverPhoto: string;
  latestDate: string;
  allSeed: boolean;
  preview: Array<{ id: string; name: string; date: string; note: string }>;
}

export interface MemoryGlobePin {
  id: string;
  location: { id: string; name: string; country: string; lat: number; lng: number };
  region: { id: string; name: string; country: string; center: [number, number]; geometry: Geometry } | null;
  locations: MemoryGlobeLocation[];
  allSeed: boolean;
  memoryCount: number;
  coverPhoto: string;
  latestDate: string;
  preview: Array<{ id: string; name: string; note: string }>;
}

export type MemoryGlobeApiPin = Omit<MemoryGlobePin, "coverPhoto" | "locations"> & {
  coverItemId: string;
  locations: Array<Omit<MemoryGlobeLocation, "coverPhoto">>;
};

const cityRows = `北京,39.90,116.40|上海,31.23,121.47|广州,23.13,113.26|深圳,22.54,114.06|成都,30.57,104.07|重庆,29.56,106.55|杭州,30.27,120.15|武汉,30.59,114.30|西安,34.34,108.94|南京,32.06,118.80|厦门,24.48,118.09|昆明,25.04,102.71|香港,22.32,114.17|台北,25.03,121.57|首尔,37.57,126.98|东京,35.68,139.69|大阪,34.69,135.50|曼谷,13.76,100.50|河内,21.03,105.85|新加坡,1.35,103.82|雅加达,-6.21,106.85|马尼拉,14.60,120.98|德里,28.61,77.21|孟买,19.08,72.88|迪拜,25.20,55.27|伊斯坦布尔,41.01,28.98|莫斯科,55.76,37.62|柏林,52.52,13.41|巴黎,48.86,2.35|罗马,41.90,12.50|马德里,40.42,-3.70|伦敦,51.51,-0.13|阿姆斯特丹,52.37,4.90|雅典,37.98,23.73|开罗,30.04,31.24|拉各斯,6.52,3.38|内罗毕,-1.29,36.82|开普敦,-33.92,18.42|纽约,40.71,-74.01|波士顿,42.36,-71.06|芝加哥,41.88,-87.63|迈阿密,25.76,-80.19|洛杉矶,34.05,-118.24|旧金山,37.77,-122.42|西雅图,47.61,-122.33|温哥华,49.28,-123.12|多伦多,43.65,-79.38|墨西哥城,19.43,-99.13|波哥大,4.71,-74.07|利马,-12.05,-77.04|圣地亚哥,-33.45,-70.67|布宜诺斯艾利斯,-34.60,-58.38|里约热内卢,-22.91,-43.17|圣保罗,-23.55,-46.63|悉尼,-33.87,151.21|墨尔本,-37.81,144.96|奥克兰,-36.85,174.76|珀斯,-31.95,115.86`;

const cities = cityRows.split("|").map((row) => {
  const [name, lat, lng] = row.split(",");
  return { name, lat: Number(lat), lng: Number(lng) };
});

const coastlines = mesh(world as never, world.objects.countries as never, (a, b) => a === b);
const countryBorders = mesh(world as never, world.objects.countries as never, (a, b) => a !== b);
const palette = ["#e9ad69", "#79bd76", "#40aaa1", "#b7ca59"];
type Hover = { pin: MemoryGlobePin; location: MemoryGlobeLocation; x: number; y: number } | null;

export function MemoryGlobe({ pins }: { pins: MemoryGlobePin[] }) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover>(null);
  const wrapWidth = wrapRef.current?.clientWidth ?? 360;
  const wrapHeight = wrapRef.current?.clientHeight ?? 420;
  const hoverCardWidth = 218;
  const hoverCardHeight = 238;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0, height = 0, baseRadius = 0, radius = 0, centerX = 0, centerY = 0;
    let longitude = -105, latitude = -10, lastX = 0, lastY = 0, pressX = 0, pressY = 0, velocity = 0;
    let dragging = false, pointerX = -999, pointerY = -999, frame = 0;
    let previous = performance.now(), hoverId = "", hoverVisibleUntil = 0, candidateId = "", moved = false;
    let zoom = 1, pinchStartDistance = 0, pinchStartZoom = 1;
    const activePointers = new Map<number, { x: number; y: number }>();
    let hitTargets: Array<{ pin: MemoryGlobePin; location: MemoryGlobeLocation; x: number; y: number }> = [];
    const projection = geoOrthographic().clipAngle(90).precision(0.4);
    const path = geoPath(projection, context);

    function resize() {
      const bounds = wrap!.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      width = bounds.width; height = bounds.height;
      canvas!.width = width * ratio; canvas!.height = height * ratio;
      canvas!.style.width = `${width}px`; canvas!.style.height = `${height}px`;
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      baseRadius = Math.min(width, height) * 0.39;
      radius = baseRadius * zoom;
      centerX = width * 0.5; centerY = height * 0.51;
    }

    function configureProjection() {
      projection.translate([centerX, centerY]).scale(radius).rotate([longitude, latitude, 0]);
    }

    function isFront(lng: number, lat: number) {
      const center = projection.invert?.([centerX, centerY]);
      return Boolean(center && geoDistance([lng, lat], center) <= Math.PI / 2);
    }

    function drawPoint(lng: number, lat: number, color: string, pointRadius: number) {
      const point = projection([lng, lat]);
      if (!point) return;
      context!.fillStyle = color;
      context!.beginPath(); context!.arc(point[0], point[1], pointRadius, 0, Math.PI * 2); context!.fill();
    }

    function draw(timestamp: number) {
      const elapsed = timestamp - previous;
      previous = timestamp;
      if (!dragging && activePointers.size < 2) longitude += elapsed * 0.006 + velocity;
      velocity *= 0.94;
      radius = baseRadius * zoom;
      configureProjection();
      context!.clearRect(0, 0, width, height);

      // Transparent bubble: the globe itself never receives a fill.
      context!.beginPath(); context!.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context!.strokeStyle = "rgba(48,145,133,.28)"; context!.lineWidth = 1; context!.stroke();

      // Back-side context points remain visible, but gray.
      for (const city of cities) {
        if (isFront(city.lng, city.lat)) continue;
        drawPoint(city.lng, city.lat, "rgba(92,99,96,.44)", 1.35);
      }

      let nearest: Hover = null;

      // Only regions derived from the GitHub seed records are filled.
      pins.forEach((pin, index) => {
        if (!pin.region) return;
        const color = palette[index % palette.length];
        context!.beginPath();
        path({ type: "Feature", properties: {}, geometry: pin.region.geometry } as never);
        context!.shadowColor = color;
        // 示例数据画得更淡，让用户自己的记录一眼跳出来
        context!.shadowBlur = pin.allSeed ? 8 : 12;
        context!.fillStyle = `${color}${pin.allSeed ? "66" : "d4"}`;
        context!.fill();
        context!.shadowBlur = 0;
        context!.strokeStyle = pin.allSeed ? `${color}80` : color;
        context!.lineWidth = pin.allSeed ? 0.8 : 1.15;
        context!.stroke();
      });

      // Original wireframe is always rendered above highlighted regions.
      context!.beginPath(); path(coastlines as never);
      context!.strokeStyle = "rgba(55,137,127,.48)"; context!.lineWidth = 0.8; context!.stroke();
      context!.beginPath(); path(countryBorders as never);
      context!.strokeStyle = "rgba(100,123,117,.28)"; context!.lineWidth = 0.55; context!.stroke();

      for (const city of cities) {
        if (!isFront(city.lng, city.lat)) continue;
        drawPoint(city.lng, city.lat, "rgba(75,132,122,.42)", 1.55);
      }

      // Short stem plus a glowing round point.
      hitTargets = [];
      pins.forEach((pin, pinIndex) => {
        pin.locations.forEach((location, locationIndex) => {
          if (!isFront(location.lng, location.lat)) return;
          const base = projection([location.lng, location.lat]);
          if (!base) return;
          const color = palette[(pinIndex + locationIndex) % palette.length];
          const isSeedPin = location.allSeed;
          const markerHeight = 12 + Math.min(location.itemIds.length - 1, 2) * 2;
          const centerX = base[0];
          const centerY = base[1] - markerHeight;
          context!.strokeStyle = isSeedPin
            ? "rgba(40,137,125,.34)"
            : "rgba(40,137,125,.78)";
          context!.lineWidth = 0.9;
          context!.beginPath();
          context!.moveTo(base[0], base[1]);
          context!.lineTo(centerX, centerY);
          context!.stroke();
          const pulse = Math.sin(timestamp / 520 + pinIndex + locationIndex);
          context!.shadowColor = color;
          context!.shadowBlur = (isSeedPin ? 9 : 13) + pulse * 2;
          context!.fillStyle = isSeedPin ? `${color}d9` : color;
          context!.beginPath(); context!.arc(centerX, centerY, isSeedPin ? 3.3 : 3.8, 0, Math.PI * 2); context!.fill();
          context!.shadowBlur = 0;
          context!.fillStyle = isSeedPin
            ? "rgba(255,253,247,.7)"
            : "rgba(255,253,247,.94)";
          context!.beginPath(); context!.arc(centerX, centerY, 1.05, 0, Math.PI * 2); context!.fill();
          hitTargets.push({ pin, location, x: centerX, y: centerY });
          if (Math.hypot(pointerX - centerX, pointerY - centerY) < 15) {
            nearest = { pin, location, x: centerX, y: centerY };
          }
        });
      });

      // Safety fallback only if a record cannot resolve to Admin-1.
      for (const pin of pins) {
        if (pin.region || !isFront(pin.location.lng, pin.location.lat)) continue;
        const point = projection([pin.location.lng, pin.location.lat]);
        if (!point) continue;
        context!.fillStyle = "#e9ad69";
        context!.beginPath(); context!.arc(point[0], point[1], 4.5, 0, Math.PI * 2); context!.fill();
        if (Math.hypot(pointerX - point[0], pointerY - point[1]) < 20) {
          const location = pin.locations[0];
          if (location) nearest = { pin, location, x: point[0], y: point[1] };
        }
      }

      const nextId = nearest ? `${nearest.pin.id}:${nearest.location.id}` : "";
      if (nextId !== candidateId) {
        candidateId = nextId;
        if (nearest) {
          hoverId = nextId;
          hoverVisibleUntil = timestamp + 3_000;
          setHover(nearest);
        }
      }
      if (hoverId && timestamp >= hoverVisibleUntil) {
        hoverId = "";
        setHover(null);
      }
      frame = requestAnimationFrame(draw);
    }

    function pointerDown(event: PointerEvent) {
      const bounds = canvas!.getBoundingClientRect();
      pointerX = event.clientX - bounds.left; pointerY = event.clientY - bounds.top;
      const target = hitTargets.find((candidate) => Math.hypot(pointerX - candidate.x, pointerY - candidate.y) < 19);
      if (event.pointerType !== "mouse" && target) {
        hoverId = `${target.pin.id}:${target.location.id}`;
        candidateId = hoverId;
        hoverVisibleUntil = performance.now() + 3_000;
        setHover(target);
        return;
      }
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas!.setPointerCapture(event.pointerId);
      if (activePointers.size === 2) {
        const [first, second] = [...activePointers.values()];
        if (!first || !second) return;
        pinchStartDistance = Math.hypot(second.x - first.x, second.y - first.y);
        pinchStartZoom = zoom;
        dragging = false;
        moved = true;
        return;
      }
      dragging = true; moved = false; pressX = event.clientX; pressY = event.clientY;
      lastX = event.clientX; lastY = event.clientY;
    }
    function pointerMove(event: PointerEvent) {
      const bounds = canvas!.getBoundingClientRect();
      pointerX = event.clientX - bounds.left; pointerY = event.clientY - bounds.top;
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (activePointers.size >= 2) {
        const [first, second] = [...activePointers.values()];
        if (!first || !second) return;
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        if (pinchStartDistance > 0) {
          zoom = Math.max(0.72, Math.min(1.75, pinchStartZoom * distance / pinchStartDistance));
        }
        moved = true;
        return;
      }
      if (!dragging) return;
      if (Math.hypot(event.clientX - pressX, event.clientY - pressY) > 5) moved = true;
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      longitude += dx * 0.32; latitude = Math.max(-65, Math.min(65, latitude - dy * 0.22));
      velocity = dx * 0.025; lastX = event.clientX; lastY = event.clientY;
    }
    function pointerUp(event: PointerEvent) {
      activePointers.delete(event.pointerId);
      dragging = false;
      if (moved && event.pointerType !== "mouse") { pointerX = -999; pointerY = -999; }
    }
    function pointerLeave() {
      pointerX = -999; pointerY = -999;
      candidateId = "";
    }
    function wheel(event: WheelEvent) {
      event.preventDefault();
      zoom = Math.max(0.72, Math.min(1.75, zoom * Math.exp(-event.deltaY * 0.0012)));
    }

    const observer = new ResizeObserver(resize);
    observer.observe(wrap); resize();
    canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", pointerUp); canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    frame = requestAnimationFrame(draw);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", pointerUp); canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [pins]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "clamp(360px, 74vw, 610px)", overflow: "hidden", borderRadius: 24, border: "1px solid rgba(44,130,120,.18)", background: "#f7f5ed" }}>
      <canvas ref={canvasRef} style={{ display: "block", cursor: "grab", touchAction: "none" }} />
      <div style={{ position: "absolute", left: 18, top: 16, color: "#568078", fontSize: 12, letterSpacing: ".14em" }}>拖动旋转 · 双指缩放 · 悬停查看</div>
      {pins.some((pin) => pin.allSeed) ? (
        <div
          style={{ position: "absolute", left: 18, bottom: 14, display: "flex", alignItems: "center", gap: 6, color: "#7d9a93", fontSize: 11 }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#40aaa1", opacity: 0.4 }} />
          浅色 = 示例数据
        </div>
      ) : null}
      {hover ? (
        <button
          type="button"
          onClick={() => router.push(`/item/${hover.location.preview[0]?.id ?? hover.location.itemIds[0]}`)}
          style={{ position: "absolute", left: Math.min(Math.max(8, hover.x + 6), Math.max(8, wrapWidth - hoverCardWidth - 8)), top: Math.min(Math.max(18, hover.y - 92), Math.max(18, wrapHeight - hoverCardHeight - 10)), width: hoverCardWidth, padding: 8, textAlign: "left", font: "inherit", cursor: "pointer", background: "rgba(255,253,247,.97)", border: "1px solid rgba(57,139,128,.3)", boxShadow: "7px 9px 0 rgba(98,160,139,.11), 0 16px 34px rgba(42,91,84,.13)", transform: "rotate(-1deg)" }}
          aria-label={`打开${hover.location.name}的记录`}
        >
          <img src={hover.location.coverPhoto} alt="" style={{ width: "100%", height: 112, objectFit: "cover", display: "block" }} />
          <div style={{ padding: "9px 6px 5px" }}>
            <strong style={{ color: "#17675f" }}>{hover.location.name}</strong>
            <small style={{ float: "right", color: "#8aa16d" }}>{hover.location.itemIds.length} 条遇见</small>
            <div style={{ clear: "both", paddingTop: 4, color: "#799087", fontSize: 11 }}>{hover.pin.region?.name}</div>
            <p style={{ margin: "6px 0 0", color: "#526f69", fontSize: 12, lineHeight: 1.55 }}>{hover.location.preview[0]?.note || hover.location.preview[0]?.name}</p>
          </div>
        </button>
      ) : null}
    </div>
  );
}
