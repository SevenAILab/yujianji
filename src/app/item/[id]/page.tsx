"use client";

import { useParams } from "next/navigation";
import ItemDetail from "@/components/ItemDetail";

export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  return <ItemDetail id={id} />;
}
