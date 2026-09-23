"use client";

// 哪些藏品已经有 3D 模型：示例模型清单 + 吉米的 manifest.json（同一个 id 以后者为准）。
// 精神图景和手帐页共用这一份，保证「手帐里能跳去看它」和「图景里真的有它」对得上。
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { parseManifest, type ModelEntry } from "@/lib/universe/nodes";

const MANIFEST_URL = "/assets/models/manifest.json";
// 示例照片对应的模型单独放一份，不和吉米产出的 manifest.json 抢同一个文件
const DEMO_MANIFEST_URL = "/assets/models/demo-manifest.json";

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // 文件不存在、JSON 坏了：当作没有
  }
}

let manifestPromise: Promise<Map<string, ModelEntry>> | null = null;

export function loadModelManifest(): Promise<Map<string, ModelEntry>> {
  manifestPromise ??= Promise.all([fetchJson(DEMO_MANIFEST_URL), fetchJson(MANIFEST_URL)]).then(
    ([demo, main]) => new Map([...parseManifest(demo), ...parseManifest(main)]),
  );
  return manifestPromise;
}

/** 模型清单；还没读到时是 null */
export function useModelManifest(): Map<string, ModelEntry> | null {
  const [manifest, setManifest] = useState<Map<string, ModelEntry> | null>(null);
  useEffect(() => {
    let active = true;
    void loadModelManifest().then((value) => active && setManifest(value));
    return () => {
      active = false;
    };
  }, []);
  return manifest;
}

/**
 * 本机照片建成的模型（models3d 表）→ blob: 地址。同源 iframe 里的精神图景可以直接读。
 * 地址跟着记录变，卸载或记录更新时释放旧地址。
 */
export function useLocalModels(): Map<string, ModelEntry> {
  const rows = useLiveQuery(() => db.models3d.where("state").equals("ready").toArray(), [], []);
  const [entries, setEntries] = useState<Map<string, ModelEntry>>(new Map());
  const key = rows.map((row) => `${row.itemId}:${row.updatedAt}`).join("|");
  useEffect(() => {
    const urls: string[] = [];
    const next = new Map<string, ModelEntry>();
    for (const row of rows) {
      if (!row.glb) continue;
      const url = URL.createObjectURL(new Blob([row.glb], { type: "model/gltf-binary" }));
      urls.push(url);
      next.set(row.itemId, { glbUrl: url });
    }
    setEntries(next);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return entries;
}

/** 有 3D 模型的藏品 id（示例清单 + 吉米清单 + 本机建成的）。手帐页用它决定要不要显示「在精神图景里看它」 */
export function useModelIds(): ReadonlySet<string> {
  const manifest = useModelManifest();
  const local = useLiveQuery(async () => (await db.models3d.where("state").equals("ready").primaryKeys()).map(String), [], []);
  return useMemo(() => new Set([...(manifest?.keys() ?? []), ...local]), [manifest, local]);
}
