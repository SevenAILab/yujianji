"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PanoramaScreen } from "@/components/PanoramaScreen";

function LocalPanorama() {
  const params = useSearchParams();
  return <PanoramaScreen id={params.get("id") ?? ""} />;
}

export default function PanoramaQueryPage() {
  return (
    <Suspense fallback={<p>正在打开全景…</p>}>
      <LocalPanorama />
    </Suspense>
  );
}
