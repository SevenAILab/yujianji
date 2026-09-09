"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PanoramaViewer } from "@/components/PanoramaViewer";
import { db, ensureSeeded } from "@/lib/db";
import { itemHref } from "@/lib/app-mode";
import type { Item } from "@/lib/types";

const shell = {
  minHeight: "100svh",
  display: "grid",
  placeItems: "center",
  background: "#f7f5ed",
  color: "#507973",
} as const;

/**
 * 全景页的正文。动态段版本和 ?id= 版本共用它 ——
 * 静态导出（原生离线包）不支持动态段，所以两种入口都要有。
 */
export function PanoramaScreen({ id }: { id: string }) {
  const router = useRouter();
  const [item, setItem] = useState<Item | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void ensureSeeded()
      .then(() => db.items.get(id))
      .then((record) => {
        if (active) setItem(record ?? null);
      })
      .catch(() => {
        if (active) setItem(null);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (item === undefined) {
    return <main style={shell}>正在打开全景…</main>;
  }

  if (!item) {
    return (
      <main style={shell}>
        <button
          type="button"
          onClick={() => router.replace("/")}
          style={{ border: 0, background: "transparent", color: "inherit" }}
        >
          这张全景暂时找不到，返回地球
        </button>
      </main>
    );
  }

  return (
    <PanoramaViewer
      photo={item.photo}
      name={item.name}
      onExit={() => router.replace("/")}
      onOpenDetail={() => router.push(itemHref(item.id))}
    />
  );
}
