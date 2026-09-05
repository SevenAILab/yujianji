export const LOCAL_ONLY = process.env.NEXT_PUBLIC_LOCAL_ONLY === "true";

export function itemHref(id: string): string {
  return LOCAL_ONLY ? `/item/?id=${encodeURIComponent(id)}` : `/item/${encodeURIComponent(id)}`;
}
