"use client";

// 精神图景：佳娴的记忆图景宇宙模块（public/memory-universe，同源 iframe）+ 遇见集的数据。
// - 节点和手帐是同一份：本机的「第一次」里有 3D 模型的那些（示例 + 自己拍的），按时间从里往外排。
// - 点物件 → 回到那天手帐里对应的那一段；右上「3D 打印」进入挑选，点物件改为打开打印面板。
// - 手帐里点「在精神图景里看它」带 ?focus=<itemId> 过来，镜头直接飞到那一件。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { PrintSheet } from "@/components/universe/PrintSheet";
import { useUniverseNodes } from "@/components/universe/useUniverseNodes";
import type { UniverseNode } from "@/lib/universe/nodes";
import styles from "./universe.module.css";

export default function UniversePage() {
  return (
    <Suspense fallback={<main className={styles.shell} />}>
      <Universe />
    </Suspense>
  );
}

function Universe() {
  const router = useRouter();
  const focus = useSearchParams().get("focus");
  const { nodes, loading } = useUniverseNodes();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [printing, setPrinting] = useState<UniverseNode | null>(null);
  const [loaded, setLoaded] = useState(0);

  // 模块只画有模型的；没模型的（还在成形）只计数
  const modeled = useMemo(() => nodes.filter((node) => node.model), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const focused = focus ? byId.get(focus) : undefined;
  // 节点集合变了就换一个 iframe（模块只会追加，不会删）
  const frameKey = modeled.map((node) => node.id).join("|");

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  const sendNodes = useCallback(() => {
    post({ type: "memory-universe:nodes", nodes: modeled.map((node) => ({ id: node.id, name: node.name, url: node.model!.glbUrl })) });
    if (focus) post({ type: "memory-universe:focus", id: focus });
  }, [post, modeled, focus]);

  const pickingRef = useRef(picking);
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; id?: string; count?: number };
      if (data?.type === "memory-universe:ready") sendNodes();
      if (data?.type === "memory-universe:loaded" && typeof data.count === "number") setLoaded(data.count);
      if (data?.type === "memory-universe:enter-globe") router.push("/");
      if (data?.type === "memory-universe:open" && data.id) {
        const node = byId.get(data.id);
        if (!node) return;
        if (pickingRef.current) {
          setPrinting(node);
          setPicking(false);
        } else if (node.href) router.push(node.href);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router, byId, sendNodes]);

  const forming = nodes.length - modeled.length;
  const subtitle = loading
    ? "正在展开…"
    : !modeled.length
      ? "拍下你的第一次，它会在这里长成一件 3D 物件"
      : `${modeled.length} 件第一次${forming ? ` · ${forming} 件正在成形` : ""}，最早的在最里面`;

  return (
    <main className={styles.shell} data-loaded={loaded} data-nodes={modeled.length}>
      {loading ? null : (
        <iframe key={frameKey} ref={frameRef} className={styles.scene} src="/memory-universe/index.html?source=parent" title="精神图景" allow="fullscreen" />
      )}
      <header className={styles.header}>
        <div className={styles.title}>
          <h1>精神图景</h1>
          <p>{subtitle}</p>
        </div>
        <div className={styles.actionStack}>
          <Link href="/" className={styles.back}>
            <ChevronLeft size={16} /> 回到地球
          </Link>
          {modeled.length ? (
            <button type="button" className={`${styles.printButton} ${picking ? styles.printButtonActive : ""}`} onClick={() => setPicking((value) => !value)} aria-pressed={picking}>
              <Printer size={15} /> {picking ? "取消打印" : "3D 打印"}
            </button>
          ) : null}
        </div>
      </header>
      {picking ? (
        <p className={styles.pickHint}>点一件想带回现实的记忆 · {modeled.length} 件可以打印</p>
      ) : focused?.href ? (
        <Link href={focused.href} className={styles.focusPill}>
          正在看「{focused.name}」· 回到那天的手帐 →
        </Link>
      ) : null}
      {printing ? <PrintSheet node={printing} onClose={() => setPrinting(null)} /> : null}
    </main>
  );
}
