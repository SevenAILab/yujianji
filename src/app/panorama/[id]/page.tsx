"use client";

import { useParams } from "next/navigation";
import { PanoramaScreen } from "@/components/PanoramaScreen";

export default function PanoramaPage() {
  const params = useParams<{ id: string }>();
  return <PanoramaScreen id={params.id} />;
}
