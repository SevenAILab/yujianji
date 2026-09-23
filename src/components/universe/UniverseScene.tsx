"use client";

// 记忆宇宙场景（工单 Gate 4.2）：中心是地球（坐标原点），"第一次"按时间一圈圈往外排。
// 有 GLB 的物件：表面采样成粒子；没有或加载失败的：「正在成形」的光点团——不拿别的模型冒充。
// 盯着 3 秒不动，粒子慢慢散开；一碰就凝住（uDisperse）。
//
// 性能红线：手机粒子总数 ≤ 20k，电脑 ≤ 50k；DPR 最高 2；页面隐藏时停渲染；卸载时全部释放。
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { ringSlots, type UniverseNode } from "@/lib/universe/nodes";

const BG = 0x070d24;
const RING_R0 = 3.2;
const RING_GAP = 1.9;
const STAR_COUNT = 1400;
const EARTH_POINTS = 1600;
const FORMING_POINTS = 260;
const IDLE_BEFORE_DISPERSE_MS = 3000;

export interface UniverseStats {
  nodes: number;
  points: number;
  models: number;
  frames: number;
  /** 仅开发环境：每个节点在画布上的位置（CSS 像素），给自动化验收点击用 */
  screen?: { id: string; x: number; y: number }[];
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uDisperse;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute vec3 aNormal;
  attribute float aSeed;
  varying float vAlpha;
  void main() {
    vec3 drift = normalize(aNormal + vec3(sin(aSeed * 12.9), cos(aSeed * 78.2), sin(aSeed * 37.7)) * 0.6);
    vec3 p = position + drift * uDisperse * (0.12 + aSeed * 0.38);
    p += vec3(sin(uTime * 0.8 + aSeed * 40.0), cos(uTime * 0.7 + aSeed * 30.0), 0.0) * 0.015;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (1.0 - uDisperse * 0.25) / -mv.z;
    vAlpha = 1.0 - uDisperse * 0.35;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPulse;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, glow * vAlpha * uPulse);
  }
`;

function pointMaterial(color: THREE.ColorRepresentation, size: number, pixelRatio: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDisperse: { value: 0 },
      uSize: { value: size },
      uPixelRatio: { value: pixelRatio },
      uColor: { value: new THREE.Color(color) },
      uPulse: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** 在一个网格表面按面积均匀采样 count 个点，带法线（给散开方向用） */
function sampleMesh(mesh: THREE.Mesh, count: number): THREE.BufferGeometry {
  const sampler = new MeshSurfaceSampler(mesh).build();
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    sampler.sample(p, n);
    positions.set([p.x, p.y, p.z], i * 3);
    normals.set([n.x, n.y, n.z], i * 3);
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aNormal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return geometry;
}

/** 球面/球内随机点：地球、「正在成形」的光点团都用它 */
function cloudGeometry(count: number, radius: number, shell: boolean): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    // 斐波那契球：地球上的点分布均匀
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
    const len = shell ? radius : radius * Math.cbrt(Math.random());
    positions.set([dir.x * len, dir.y * len, dir.z * len], i * 3);
    normals.set([dir.x, dir.y, dir.z], i * 3);
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aNormal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return geometry;
}

function nebulaTexture(inner: string, outer: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function UniverseScene({ nodes, onOpen, onStats }: { nodes: UniverseNode[]; onOpen: (node: UniverseNode) => void; onStats?: (stats: UniverseStats) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onOpenRef = useRef(onOpen);
  const onStatsRef = useRef(onStats);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    onOpenRef.current = onOpen;
    onStatsRef.current = onStats;
  }, [onOpen, onStats]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const budget = coarse ? 20_000 : 50_000;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(BG, 1);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    const outerRadius = RING_R0 + RING_GAP * Math.max(0, (ringSlots(nodes.length).at(-1)?.ring ?? 0));
    camera.position.set(0, outerRadius * 0.9 + 4, outerRadius * 1.6 + 6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 4;
    controls.maxDistance = 60;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;

    const disposables: { dispose: () => void }[] = [];
    const materials: THREE.ShaderMaterial[] = [];
    let pointTotal = 0;
    let modelCount = 0;
    let frames = 0;

    // ── 背景：星空 + 几团缓慢漂移的星云 ──
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const dir = new THREE.Vector3().randomDirection().multiplyScalar(70 + Math.random() * 90);
      starPositions.set([dir.x, dir.y, dir.z], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xcfe3ff, size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0.8, depthWrite: false });
    scene.add(new THREE.Points(starGeo, starMat));
    disposables.push(starGeo, starMat);
    pointTotal += STAR_COUNT;

    const nebulae = new THREE.Group();
    const palette: [string, string][] = [
      ["rgba(88,120,255,0.35)", "rgba(88,120,255,0)"],
      ["rgba(64,190,180,0.28)", "rgba(64,190,180,0)"],
      ["rgba(170,90,220,0.22)", "rgba(170,90,220,0)"],
    ];
    for (let i = 0; i < 6; i += 1) {
      const [a, b] = palette[i % palette.length];
      const texture = nebulaTexture(a, b);
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(material);
      const dir = new THREE.Vector3().randomDirection().multiplyScalar(45 + Math.random() * 25);
      sprite.position.copy(dir);
      sprite.scale.setScalar(40 + Math.random() * 40);
      nebulae.add(sprite);
      disposables.push(texture, material);
    }
    scene.add(nebulae);

    // ── 中心：粒子地球 ──
    const earthGeo = cloudGeometry(EARTH_POINTS, 0.95, true);
    const earthMat = pointMaterial(0x6fd6c6, 34, pixelRatio);
    const earth = new THREE.Points(earthGeo, earthMat);
    scene.add(earth);
    disposables.push(earthGeo, earthMat);
    materials.push(earthMat);
    pointTotal += EARTH_POINTS;

    // ── 圈层 ──
    const slots = ringSlots(nodes.length);
    const ringGroups: THREE.Group[] = [];
    const ringCount = (slots.at(-1)?.ring ?? -1) + 1;
    for (let r = 0; r < ringCount; r += 1) {
      const group = new THREE.Group();
      group.rotation.x = (r % 2 ? 1 : -1) * 0.08;
      const curve = new THREE.EllipseCurve(0, 0, RING_R0 + r * RING_GAP, RING_R0 + r * RING_GAP);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(160).map((p) => new THREE.Vector3(p.x, 0, p.y)));
      const lineMat = new THREE.LineBasicMaterial({ color: 0x6f8fd8, transparent: true, opacity: 0.18 });
      group.add(new THREE.LineLoop(lineGeo, lineMat));
      disposables.push(lineGeo, lineMat);
      scene.add(group);
      ringGroups.push(group);
    }

    // ── 节点 ──
    const perNode = Math.max(200, Math.min(2000, Math.floor((budget - pointTotal) / Math.max(1, nodes.length))));
    const hitTargets: THREE.Mesh[] = [];
    const hitGeo = new THREE.SphereGeometry(0.75, 8, 8);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    disposables.push(hitGeo, hitMat);
    // 示例模型用 gltf-transform 做过减面 + meshopt 压缩（几十 MB → 几百 KB），要先装解码器
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let disposed = false;

    nodes.forEach((node, i) => {
      const slot = slots[i];
      const radius = RING_R0 + slot.ring * RING_GAP;
      const angle = (slot.index / slot.size) * Math.PI * 2 + slot.ring * 0.7;
      const holder = new THREE.Group();
      holder.position.set(Math.cos(angle) * radius, Math.sin(i * 1.7) * 0.25, Math.sin(angle) * radius);
      ringGroups[slot.ring].add(holder);

      const color = node.color ?? (node.sample ? "#9fb6ff" : "#ffd9a0");
      const forming = pointMaterial(color, 38, pixelRatio);
      const formingGeo = cloudGeometry(FORMING_POINTS, 0.42, false);
      const formingPoints = new THREE.Points(formingGeo, forming);
      holder.add(formingPoints);
      disposables.push(formingGeo, forming);
      materials.push(forming);
      forming.userData.forming = true;
      pointTotal += FORMING_POINTS;

      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.userData.node = node;
      holder.add(hit);
      hitTargets.push(hit);

      if (!node.model) return;
      loader.load(
        node.model.glbUrl,
        (gltf) => {
          if (disposed) return;
          // 合并成一个网格再采样：多个子网格按各自面积分配点数太麻烦，演示用不上
          const meshes: THREE.Mesh[] = [];
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
          });
          if (!meshes.length) return;
          const geometries = meshes.map((mesh) => {
            const source = mesh.geometry.clone();
            const g = source.index ? source.toNonIndexed() : source;
            g.applyMatrix4(mesh.matrixWorld);
            for (const key of Object.keys(g.attributes)) if (key !== "position" && key !== "normal") g.deleteAttribute(key);
            if (!g.attributes.normal) g.computeVertexNormals();
            return g;
          });
          const merged = mergeGeometries(geometries);
          geometries.forEach((g) => g.dispose());
          if (!merged) return;
          merged.computeBoundingBox();
          const box = merged.boundingBox!;
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          merged.translate(-center.x, -center.y, -center.z);
          const scale = 1.4 / Math.max(size.x, size.y, size.z, 1e-6);
          merged.scale(scale, scale, scale);
          const sampled = sampleMesh(new THREE.Mesh(merged), perNode);
          merged.dispose();
          const material = pointMaterial(node.color ?? "#ffe6c2", 26, pixelRatio);
          holder.add(new THREE.Points(sampled, material));
          holder.remove(formingPoints);
          formingGeo.dispose();
          forming.dispose();
          disposables.push(sampled, material);
          materials.push(material);
          pointTotal += perNode - FORMING_POINTS;
          modelCount += 1;
        },
        undefined,
        () => {
          // 加载失败就一直是「正在成形」
        },
      );
    });

    // ── 交互：点物件回到那天的手帐；拖动/缩放时粒子凝住 ──
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastInteraction = performance.now();
    let downAt: { x: number; y: number } | null = null;
    const touch = () => {
      lastInteraction = performance.now();
    };
    const onDown = (event: PointerEvent) => {
      touch();
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      touch();
      if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 8) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(hitTargets, false)[0];
      const node = hit?.object.userData.node as UniverseNode | undefined;
      if (node) onOpenRef.current(node);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("wheel", touch, { passive: true });

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      renderer.setSize(Math.max(1, width), Math.max(1, height), false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = Math.max(1, width) / Math.max(1, height);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // ── 渲染循环：页面隐藏就停 ──
    const clock = new THREE.Clock();
    let disperse = 0;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const idle = performance.now() - lastInteraction > IDLE_BEFORE_DISPERSE_MS;
      disperse += ((idle ? 1 : 0) - disperse) * Math.min(1, dt * (idle ? 0.35 : 3));
      for (const material of materials) {
        material.uniforms.uTime.value = t;
        material.uniforms.uDisperse.value = material === earthMat ? 0 : disperse;
        if (material.userData.forming) material.uniforms.uPulse.value = 0.55 + 0.45 * Math.sin(t * 2.4);
      }
      earth.rotation.y += dt * 0.12;
      ringGroups.forEach((group, r) => (group.rotation.y += dt * (0.05 / (r + 1)) * (r % 2 ? -1 : 1)));
      nebulae.rotation.y += dt * 0.004;
      controls.update();
      renderer.render(scene, camera);
      frames += 1;
      if (frames % 30 === 0) {
        let screen: UniverseStats["screen"];
        if (process.env.NODE_ENV !== "production") {
          const rect = renderer.domElement.getBoundingClientRect();
          const v = new THREE.Vector3();
          screen = hitTargets.map((hit) => {
            hit.getWorldPosition(v).project(camera);
            return { id: (hit.userData.node as UniverseNode).id, x: Math.round(((v.x + 1) / 2) * rect.width), y: Math.round(((1 - v.y) / 2) * rect.height) };
          });
        }
        onStatsRef.current?.({ nodes: nodes.length, points: pointTotal, models: modelCount, frames, screen });
      }
    };
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else {
        clock.getDelta();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("wheel", touch);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [nodes]);

  if (failed) {
    return <div style={{ padding: 24, color: "#cfe3ff" }}>这个浏览器不支持 WebGL，打不开记忆宇宙。</div>;
  }
  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}

/** 只合并 position + normal 的非索引几何体（逐点读，兼容交错/量化存储；不多引一个 BufferGeometryUtils） */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const total = geometries.reduce((sum, g) => sum + g.attributes.position.count, 0);
  if (!total) return null;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  let offset = 0;
  for (const g of geometries) {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i += 1) {
      const o = (offset + i) * 3;
      positions[o] = pos.getX(i);
      positions[o + 1] = pos.getY(i);
      positions[o + 2] = pos.getZ(i);
      normals[o] = nor.getX(i);
      normals[o + 1] = nor.getY(i);
      normals[o + 2] = nor.getZ(i);
    }
    offset += pos.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return merged;
}
