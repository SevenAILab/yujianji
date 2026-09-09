export const LOCAL_ONLY = process.env.NEXT_PUBLIC_LOCAL_ONLY === "true";

/**
 * 原生壳里页面是从 capacitor://localhost 加载的，接口必须打绝对地址。
 * Web 端留空 → 相对路径，行为与改造前完全一致。
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function itemHref(id: string): string {
  return LOCAL_ONLY ? `/item/?id=${encodeURIComponent(id)}` : `/item/${encodeURIComponent(id)}`;
}

export function panoramaHref(id: string): string {
  return LOCAL_ONLY
    ? `/panorama/?id=${encodeURIComponent(id)}`
    : `/panorama/${encodeURIComponent(id)}`;
}
