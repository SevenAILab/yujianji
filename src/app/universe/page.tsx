"use client";

// 记忆宇宙（工单 Gate 4）：地球是坐标原点，你所有的"第一次"一圈圈绕着它。
// 点一个物件，回到那天的手帐。宇宙页不弹详情卡片（9/23 已定）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { UniverseScene, type UniverseStats } from "@/components/universe/UniverseScene";
import { useUniverseNodes } from "@/components/universe/useUniverseNodes";
import type { UniverseNode } from "@/lib/universe/nodes";
import styles from "./universe.module.css";

export default function UniversePage() {
  const router = useRouter();
  const { nodes, loading, sample, demo } = useUniverseNodes();
  const [stats, setStats] = useState<UniverseStats | null>(null);
  const open = useCallback(
    (node: UniverseNode) => {
      if (node.href) router.push(node.href); // 示例节点没有 href，不可点
    },
    [router],
  );

  return (
    <main className={styles.shell} data-nodes={stats?.nodes ?? 0} data-points={stats?.points ?? 0} data-models={stats?.models ?? 0} data-frames={stats?.frames ?? 0} data-screen={stats?.screen ? JSON.stringify(stats.screen) : undefined}>
      {loading ? null : <UniverseScene nodes={nodes} onOpen={open} onStats={setStats} />}
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          <ChevronLeft size={16} /> 回到地球
        </Link>
        <div className={styles.title}>
          <h1>记忆宇宙</h1>
          <p>{loading ? "正在展开…" : sample ? "示例 · 拍下你的第一次后换成你自己的" : `${nodes.length} 个第一次${demo ? " · 演示数据" : "，最早的在最里面"}`}</p>
        </div>
      </header>
      <p className={styles.hint}>{sample ? "拖动旋转 · 双指缩放" : "拖动旋转 · 双指缩放 · 点一个物件，回到那天"}</p>
      <AppNav />
    </main>
  );
}
