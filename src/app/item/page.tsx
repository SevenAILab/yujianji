"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ItemDetail from "@/components/ItemDetail";

function LocalItem() {
  const params = useSearchParams();
  return <ItemDetail id={params.get("id") ?? ""} />;
}

export default function ItemPage() {
  return <Suspense fallback={<p>正在打开这件遇见…</p>}><LocalItem /></Suspense>;
}
