"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PanoramaViewer } from "@/components/PanoramaViewer";
import { db, ensureSeeded } from "@/lib/db";
import type { Item } from "@/lib/types";

export default function PanoramaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [item, setItem] = useState<Item | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void ensureSeeded()
      .then(() => db.items.get(params.id))
      .then((record) => {
        if (active) setItem(record ?? null);
      })
      .catch(() => {
        if (active) setItem(null);
      });
    return () => { active = false; };
  }, [params.id]);

  if (item === undefined) {
    return <main style={{ minHeight: "100svh", display: "grid", placeItems: "center", background: "#f7f5ed", color: "#507973" }}>正在打开全景…</main>;
  }

  if (!item) {
    return (
      <main style={{ minHeight: "100svh", display: "grid", placeItems: "center", background: "#f7f5ed", color: "#507973" }}>
        <button type="button" onClick={() => router.replace("/")} style={{ border: 0, background: "transparent", color: "inherit" }}>这张全景暂时找不到，返回地球</button>
      </main>
    );
  }

  return (
    <PanoramaViewer
      photo={item.photo}
      name={item.name}
      onExit={() => router.replace("/")}
      onOpenDetail={() => router.push(`/item/${item.id}`)}
    />
  );
}
