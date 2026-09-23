"use client";

// 3D 打印：从精神图景里挑一件已经成形的记忆，选尺寸和材质，生成能直接导入切片软件的 STL。
// 文件在浏览器里现场生成（GLB → 按尺寸缩放、转成 Z 轴朝上 → 二进制 STL），不经过服务器。
import { useEffect, useRef, useState } from "react";
import { Download, Printer, X } from "lucide-react";
import type { UniverseNode } from "@/lib/universe/nodes";
import styles from "./PrintSheet.module.css";

const SIZES = [
  { cm: 6, label: "钥匙扣" },
  { cm: 10, label: "桌面摆件" },
  { cm: 15, label: "收藏款" },
] as const;

const MATERIALS = [
  { id: "resin", label: "白色树脂", note: "细节最清楚" },
  { id: "color", label: "全彩打印", note: "保留照片里的颜色" },
  { id: "pla", label: "环保 PLA", note: "最便宜、最快" },
] as const;

type Phase = { kind: "choose" } | { kind: "working" } | { kind: "done"; url: string; filename: string; triangles: number } | { kind: "error"; message: string };

function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "记忆";
}

async function buildStl(glbUrl: string, sizeCm: number): Promise<{ blob: Blob; triangles: number }> {
  const [THREE, { GLTFLoader }, { MeshoptDecoder }, { STLExporter }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
    import("three/examples/jsm/exporters/STLExporter.js"),
  ]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(glbUrl);
  const root = new THREE.Group();
  root.add(gltf.scene);
  // glTF 是 Y 轴朝上，切片软件按 Z 轴朝上摆：转 90°，不然模型会躺在打印床上
  root.rotation.x = Math.PI / 2;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = (sizeCm * 10) / Math.max(size.x, size.y, size.z, 1e-6); // STL 单位是毫米
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(root);
  const center = scaled.getCenter(new THREE.Vector3());
  // 居中，底面贴住打印床
  root.position.set(-center.x, -center.y, -scaled.min.z);
  root.updateMatrixWorld(true);
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as import("three").Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  });
  const data = new STLExporter().parse(root, { binary: true }) as DataView;
  root.traverse((object) => {
    const mesh = object as import("three").Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
  return { blob: new Blob([data.buffer as ArrayBuffer], { type: "model/stl" }), triangles: Math.round(triangles) };
}

export function PrintSheet({ node, onClose }: { node: UniverseNode; onClose: () => void }) {
  const [size, setSize] = useState<(typeof SIZES)[number]["cm"]>(10);
  const [material, setMaterial] = useState<(typeof MATERIALS)[number]["id"]>("resin");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const materialLabel = MATERIALS.find((m) => m.id === material)!.label;
  const place = node.place?.split(/\s*[·・]\s*/).filter(Boolean).slice(-2).join(" · ");
  const day = node.at ? new Date(node.at).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "";

  async function generate() {
    if (!node.model) return;
    setPhase({ kind: "working" });
    try {
      const { blob, triangles } = await buildStl(node.model.glbUrl, size);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const filename = `遇见集-${safeName(node.name)}-${size}cm-${materialLabel}.stl`;
      setPhase({ kind: "done", url, filename, triangles });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    } catch {
      setPhase({ kind: "error", message: "模型文件没读出来，稍后再试一次。" });
    }
  }

  return (
    <div className={styles.backdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="print-title">
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>
              <Printer size={13} /> 3D 打印
            </p>
            <h2 id="print-title">把「{node.name}」打印出来</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className={styles.memory}>
          {node.photo ? <img src={node.photo} alt={node.name} /> : null}
          <div>
            <strong>{node.name}</strong>
            <span>{[day, place].filter(Boolean).join(" · ")}</span>
            <span className={styles.ready}>模型已成形 · 由这张照片生成</span>
          </div>
        </div>

        {phase.kind === "done" ? (
          <div className={styles.done}>
            <strong>打印文件已生成</strong>
            <p>
              {size} cm · {materialLabel} · {phase.triangles.toLocaleString("zh-CN")} 个三角面。STL 格式，可以直接导入切片软件，或者交给任何一家 3D 打印店。
            </p>
            <a className={styles.primary} href={phase.url} download={phase.filename}>
              <Download size={16} /> 再下载一次
            </a>
            <button type="button" className={styles.secondary} onClick={onClose}>
              完成
            </button>
          </div>
        ) : (
          <>
            <fieldset className={styles.group}>
              <legend>尺寸（最长边）</legend>
              <div className={styles.options}>
                {SIZES.map((option) => (
                  <button key={option.cm} type="button" aria-pressed={size === option.cm} className={styles.option} onClick={() => setSize(option.cm)}>
                    <strong>{option.cm} cm</strong>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className={styles.group}>
              <legend>材质</legend>
              <div className={styles.options}>
                {MATERIALS.map((option) => (
                  <button key={option.id} type="button" aria-pressed={material === option.id} className={styles.option} onClick={() => setMaterial(option.id)}>
                    <strong>{option.label}</strong>
                    <span>{option.note}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {phase.kind === "error" ? <p className={styles.error}>{phase.message}</p> : null}
            <button type="button" className={styles.primary} onClick={() => void generate()} disabled={phase.kind === "working" || !node.model}>
              <Printer size={16} /> {phase.kind === "working" ? "正在生成打印文件…" : "生成打印文件"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
