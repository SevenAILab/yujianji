import Link from "next/link";
import type { Item } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { itemHref } from "@/lib/app-mode";

export function ItemCard({ item }: { item: Item }) {
  return (
    <Link className="item-card" href={itemHref(item.id)}>
      <img src={item.photo} alt={item.name} />
      <div className="item-card-body">
        <strong>{item.name}</strong>
        <span>{item.place}</span>
        <span>{formatDate(item.date)}</span>
        {item.isSeed ? <small className="badge">示例数据</small> : null}
      </div>
    </Link>
  );
}
