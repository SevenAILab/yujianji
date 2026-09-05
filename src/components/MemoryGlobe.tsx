"use client";

import { geoDistance, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mesh } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import styles from "./MemoryGlobe.module.css";

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
  hasPanorama: boolean;
  panoramaItemId: string | null;
  latestDate: string;
  allSeed: boolean;
  preview: Array<{
    id: string;
    name: string;
    date: string;
    note: string;
    mediaKind: "standard" | "panorama";
    photo: string;
  }>;
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
  preview: Array<{
    id: string;
    name: string;
    date: string;
    note: string;
    mediaKind: "standard" | "panorama";
    photo: string;
  }>;
}

export type MemoryGlobeApiPin = Omit<MemoryGlobePin, "coverPhoto" | "locations" | "preview"> & {
  coverItemId: string;
  preview: Array<Omit<MemoryGlobePin["preview"][number], "photo">>;
  locations: Array<
    Omit<MemoryGlobeLocation, "coverPhoto" | "preview"> & {
      preview: Array<Omit<MemoryGlobeLocation["preview"][number], "photo">>;
    }
  >;
};

const cityRows = `北京,39.90,116.40|上海,31.23,121.47|广州,23.13,113.26|深圳,22.54,114.06|成都,30.57,104.07|重庆,29.56,106.55|杭州,30.27,120.15|武汉,30.59,114.30|西安,34.34,108.94|南京,32.06,118.80|厦门,24.48,118.09|昆明,25.04,102.71|香港,22.32,114.17|台北,25.03,121.57|首尔,37.57,126.98|东京,35.68,139.69|大阪,34.69,135.50|曼谷,13.76,100.50|河内,21.03,105.85|新加坡,1.35,103.82|雅加达,-6.21,106.85|马尼拉,14.60,120.98|德里,28.61,77.21|孟买,19.08,72.88|迪拜,25.20,55.27|伊斯坦布尔,41.01,28.98|莫斯科,55.76,37.62|柏林,52.52,13.41|巴黎,48.86,2.35|罗马,41.90,12.50|马德里,40.42,-3.70|伦敦,51.51,-0.13|阿姆斯特丹,52.37,4.90|雅典,37.98,23.73|开罗,30.04,31.24|拉各斯,6.52,3.38|内罗毕,-1.29,36.82|开普敦,-33.92,18.42|纽约,40.71,-74.01|波士顿,42.36,-71.06|芝加哥,41.88,-87.63|迈阿密,25.76,-80.19|洛杉矶,34.05,-118.24|旧金山,37.77,-122.42|西雅图,47.61,-122.33|温哥华,49.28,-123.12|多伦多,43.65,-79.38|墨西哥城,19.43,-99.13|波哥大,4.71,-74.07|利马,-12.05,-77.04|圣地亚哥,-33.45,-70.67|布宜诺斯艾利斯,-34.60,-58.38|里约热内卢,-22.91,-43.17|圣保罗,-23.55,-46.63|悉尼,-33.87,151.21|墨尔本,-37.81,144.96|奥克兰,-36.85,174.76|珀斯,-31.95,115.86`;

const cities = cityRows.split("|").map((row) => {
  const [name, lat, lng] = row.split(",");
  return { name, lat: Number(lat), lng: Number(lng) };
});

const coastlines = mesh(world as never, world.objects.countries as never, (a, b) => a === b);
const countryBorders = mesh(world as never, world.objects.countries as never, (a, b) => a !== b);
const palette = ["#e9ad69", "#79bd76", "#40aaa1", "#b7ca59"];
const panoramaPinColor = "#5b8fc2";
const MAX_GLOBE_ZOOM = 24;
type PreviewItem = MemoryGlobeLocation["preview"][number];
type Hover = {
  pin: MemoryGlobePin;
  location: MemoryGlobeLocation;
  item: PreviewItem;
  x: number;
  y: number;
} | null;

export function MemoryGlobe({ pins }: { pins: MemoryGlobePin[] }) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleElementRef = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);
  const zoomEntryLockRef = useRef(false);

  function showHover(next: Hover) {
    hoverRef.current = next;
    setHover(next);
  }

  function activateTarget(target: NonNullable<Hover>) {
    if (target.item.mediaKind === "panorama") router.push(`/panorama/${target.item.id}`);
  }

  function setBubbleElement(node: HTMLElement | null) {
    bubbleElementRef.current = node;
  }

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
    let hitTargets: Array<NonNullable<Hover>> = [];
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
      let nearestDistance = Number.POSITIVE_INFINITY;

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
          const isSeedPin = location.allSeed;
          location.preview.slice(0, 3).forEach((item, itemIndex, visibleItems) => {
            const spread = itemIndex - (visibleItems.length - 1) / 2;
            const centerX = base[0] + spread * 8;
            const centerY = base[1] - 13 - Math.abs(spread) * 2;
            const color = item.mediaKind === "panorama"
              ? panoramaPinColor
              : palette[(pinIndex + locationIndex + itemIndex) % palette.length];
            context!.strokeStyle = isSeedPin
              ? "rgba(40,137,125,.34)"
              : "rgba(40,137,125,.78)";
            context!.lineWidth = 0.8;
            context!.beginPath();
            context!.moveTo(base[0], base[1]);
            context!.lineTo(centerX, centerY);
            context!.stroke();
            const pulse = Math.sin(timestamp / 520 + pinIndex + locationIndex + itemIndex * 0.7);
            context!.shadowColor = color;
            context!.shadowBlur = (isSeedPin ? 8 : 12) + pulse * 2;
            context!.fillStyle = isSeedPin ? `${color}d9` : color;
            context!.beginPath(); context!.arc(centerX, centerY, isSeedPin ? 3.1 : 3.7, 0, Math.PI * 2); context!.fill();
            context!.shadowBlur = 0;
            if (item.mediaKind === "panorama") {
              context!.strokeStyle = "rgba(255,253,247,.9)";
              context!.lineWidth = 1;
              context!.beginPath(); context!.arc(centerX, centerY, 5.5, 0, Math.PI * 2); context!.stroke();
            }
            context!.fillStyle = isSeedPin
              ? "rgba(255,253,247,.7)"
              : "rgba(255,253,247,.94)";
            context!.beginPath(); context!.arc(centerX, centerY, 1, 0, Math.PI * 2); context!.fill();
            const target = { pin, location, item, x: centerX, y: centerY };
            hitTargets.push(target);
            const distance = Math.hypot(pointerX - centerX, pointerY - centerY);
            if (distance < 12 && distance < nearestDistance) {
              nearestDistance = distance;
              nearest = target;
            }
          });
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
          const item = location?.preview[0];
          if (location && item) nearest = { pin, location, item, x: point[0], y: point[1] };
        }
      }

      // The preview is a DOM element, so keep it attached to the projected pin
      // while the globe continues rotating and zooming.
      const activeHover = hoverRef.current;
      if (activeHover) {
        const currentTarget = hitTargets.find((target) =>
          target.location.id === activeHover.location.id && target.item.id === activeHover.item.id,
        );
        const bubble = bubbleElementRef.current;
        if (currentTarget && bubble) {
          bubble.style.left = `${currentTarget.x}px`;
          bubble.style.top = `${currentTarget.y - 38}px`;
          bubble.style.setProperty(
            "--globe-photo-scale",
            String(Math.min(3.2, Math.max(1, Math.sqrt(zoom)))),
          );
          hoverRef.current = currentTarget;
        }
      }

      const nextId = nearest ? `${nearest.pin.id}:${nearest.location.id}:${nearest.item.id}` : "";
      if (nextId !== candidateId) {
        candidateId = nextId;
        if (nearest) {
          hoverId = nextId;
          hoverVisibleUntil = timestamp + 3_000;
          showHover(nearest);
        }
      }
      if (hoverId && timestamp >= hoverVisibleUntil) {
        hoverId = "";
        showHover(null);
      }
      frame = requestAnimationFrame(draw);
    }

    function pointerDown(event: PointerEvent) {
      const bounds = canvas!.getBoundingClientRect();
      pointerX = event.clientX - bounds.left; pointerY = event.clientY - bounds.top;
      const target = hitTargets
        .map((candidate) => ({ candidate, distance: Math.hypot(pointerX - candidate.x, pointerY - candidate.y) }))
        .filter(({ distance }) => distance < 15)
        .sort((a, b) => a.distance - b.distance)[0]?.candidate;
      if (event.pointerType !== "mouse" && target) {
        hoverId = `${target.pin.id}:${target.location.id}:${target.item.id}`;
        candidateId = hoverId;
        hoverVisibleUntil = performance.now() + 3_000;
        showHover(target);
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
      if (event.pointerType !== "mouse" && target) {
        dragging = false;
        moved = false;
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
          zoom = Math.max(0.42, Math.min(MAX_GLOBE_ZOOM, pinchStartZoom * distance / pinchStartDistance));
          if (zoom < 1.42) zoomEntryLockRef.current = false;
          if (
            zoom >= 1.55 &&
            hoverRef.current?.item.mediaKind === "panorama" &&
            !zoomEntryLockRef.current
          ) {
            zoomEntryLockRef.current = true;
            activateTarget(hoverRef.current);
          }
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
      zoom = Math.max(0.42, Math.min(MAX_GLOBE_ZOOM, zoom * Math.exp(-event.deltaY * 0.0015)));
      if (zoom < 1.42) zoomEntryLockRef.current = false;
      if (
        zoom >= 1.55 &&
        hoverRef.current?.item.mediaKind === "panorama" &&
        !zoomEntryLockRef.current
      ) {
        zoomEntryLockRef.current = true;
        activateTarget(hoverRef.current);
      }
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
    <div ref={wrapRef} className={styles.globeWrap}>
      <canvas ref={canvasRef} style={{ display: "block", cursor: "grab", touchAction: "none" }} />
      <div className={styles.globeHint}>拖动旋转 · 双指缩放 · 悬停查看</div>
      {hover?.item.mediaKind === "panorama" ? (
        <button
          ref={setBubbleElement}
          type="button"
          onClick={() => activateTarget(hover)}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              event.preventDefault();
              activateTarget(hover);
            }
          }}
          className={`${styles.photoBubble} ${styles.panoramaBubble}`}
          style={{ left: hover.x, top: hover.y - 38 }}
          aria-label={`展开${hover.item.name}的360度全景`}
        >
          <img src={hover.item.photo || hover.location.coverPhoto} alt="" />
          <span>360°</span>
        </button>
      ) : hover ? (
        <div
          ref={setBubbleElement}
          className={`${styles.photoBubble} ${styles.standardBubble}`}
          style={{ left: hover.x, top: hover.y - 38 }}
          role="img"
          aria-label={`${hover.item.name}的地图缩略图`}
        >
          <img src={hover.item.photo || hover.location.coverPhoto} alt="" />
        </div>
      ) : null}
    </div>
  );
}
