"use client";

// 精神图景（记忆宇宙，工单 Gate 4）：地球是坐标原点，你所有的"第一次"一圈圈绕着它。
// 点一个物件，回到那天的手帐。宇宙页不弹详情卡片（9/23 已定）。
// 右上角「3D 打印」：进入挑选模式，点一件已成形的记忆 → 选尺寸材质 → 生成 STL。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { PrintSheet } from "@/components/universe/PrintSheet";
import { UniverseScene, type UniverseStats } from "@/components/universe/UniverseScene";
import { useUniverseNodes } from "@/components/universe/useUniverseNodes";
import type { UniverseNode } from "@/lib/universe/nodes";
import styles from "./universe.module.css";

export default function UniversePage() {
  const router = useRouter();
  const { nodes, loading, sample } = useUniverseNodes();
  const [stats, setStats] = useState<UniverseStats | null>(null);
  const [picking, setPicking] = useState(false);
  const [printing, setPrinting] = useState<UniverseNode | null>(null);
  const [toast, setToast] = useState("");
  const printable = nodes.filter((node) => node.model).length;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const open = useCallback(
    (node: UniverseNode) => {
      if (picking) {
        if (node.model) {
          setPrinting(node);
          setPicking(false);
        } else setToast(`「${node.name}」还在成形，成形以后才能打印`);
        return;
      }
      if (node.href) router.push(node.href); // 示例节点没有 href，不可点
    },
    [router, picking],
  );

  function togglePicking() {
    if (!printable) {
      setToast("还没有成形的模型，先拍一件你喜欢的东西");
      return;
    }
    setPicking((value) => !value);
  }

  return (
    <main className={styles.shell} data-nodes={stats?.nodes ?? 0} data-points={stats?.points ?? 0} data-models={stats?.models ?? 0} data-frames={stats?.frames ?? 0} data-screen={stats?.screen ? JSON.stringify(stats.screen) : undefined}>
      {loading ? null : <UniverseScene nodes={nodes} onOpen={open} onStats={setStats} />}
      <header className={styles.header}>
        <div className={styles.topRow}>
          <Link href="/" className={styles.back}>
            <ChevronLeft size={16} /> 回到地球
          </Link>
          {loading || sample ? null : (
            <button type="button" className={`${styles.printButton} ${picking ? styles.printButtonActive : ""}`} onClick={togglePicking} aria-pressed={picking}>
              <Printer size={15} /> {picking ? "取消打印" : "3D 打印"}
            </button>
          )}
        </div>
        <div className={styles.title}>
          <h1>精神图景</h1>
          <p>{loading ? "正在展开…" : sample ? "示例 · 拍下你的第一次后换成你自己的" : `${nodes.length} 个第一次，最早的在最里面`}</p>
        </div>
      </header>
      {picking ? (
        <p className={styles.pickHint}>
          点一件想带回现实的记忆 · {printable} 件已成形
        </p>
      ) : (
        <p className={styles.hint}>{sample ? "拖动旋转 · 双指缩放" : "拖动旋转 · 双指缩放 · 点一个物件，回到那天"}</p>
      )}
      {printing ? <PrintSheet node={printing} onClose={() => setPrinting(null)} /> : null}
      {toast ? <div className="toast">{toast}</div> : null}
      <AppNav />
    </main>
  );
}
