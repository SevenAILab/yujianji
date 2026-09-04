import fs from "node:fs";
import path from "node:path";
import { itemSchema } from "../src/lib/schema";

const root = process.cwd();
const seedPath = path.join(root, "data", "seed.json");
const publicSeedPath = path.join(root, "public", "seed-data.json");
const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as unknown;
const publicParsed = JSON.parse(fs.readFileSync(publicSeedPath, "utf8")) as unknown;
const result = Array.isArray(parsed)
  ? parsed.map((item) => itemSchema.safeParse(item))
  : [];
const publicResult = Array.isArray(publicParsed)
  ? publicParsed.map((item) => itemSchema.safeParse(item))
  : [];

if (
  !Array.isArray(parsed) ||
  result.some((item) => !item.success) ||
  !Array.isArray(publicParsed) ||
  publicResult.some((item) => !item.success)
) {
  console.error("seed.json 校验失败");
  result.forEach((item, index) => {
    if (!item.success) {
      console.error(`- #${index + 1}: ${item.error.message}`);
    }
  });
  publicResult.forEach((item, index) => {
    if (!item.success) {
      console.error(`- public/seed-data.json #${index + 1}: ${item.error.message}`);
    }
  });
  process.exit(1);
}

const items = parsed as Array<{
  id: string;
  photo: string;
  place: string;
  date: string;
  ai: {
    luck: { basis: string };
    verdict: string;
    relatedItemId: string | null;
  } | null;
}>;
const requiredIds = [
  "moganshan-pink-leaf-2025-10",
  "qinghai-basalt-2024-08",
];
const missingIds = requiredIds.filter((id) => !items.some((item) => item.id === id));
const missingPhotos = items.filter((item) => {
  const relative = item.photo.replace(/^\//, "");
  return !fs.existsSync(path.join(root, "public", relative));
});
const missingBasis = items.filter((item) => !item.ai?.luck.basis);
const nonFirst = items.filter(
  (item) => item.ai?.verdict !== "first" || item.ai.relatedItemId !== null,
);
const publicItems = publicParsed as typeof items;
const filesMatch = JSON.stringify(parsed) === JSON.stringify(publicParsed);
const minimum = Number(process.env.SEED_MIN_COUNT ?? "3");

if (
  items.length < minimum ||
  missingIds.length ||
  missingPhotos.length ||
  missingBasis.length ||
  nonFirst.length ||
  !filesMatch ||
  items.length !== publicItems.length
) {
  if (items.length < minimum) {
    console.error(`seed 数量不足: ${items.length} < ${minimum}`);
  }
  if (missingIds.length) console.error(`缺少 required ids: ${missingIds.join(", ")}`);
  if (missingPhotos.length) console.error(`缺少照片: ${missingPhotos.map((item) => item.photo).join(", ")}`);
  if (missingBasis.length) console.error(`缺少 luck.basis: ${missingBasis.map((item) => item.id).join(", ")}`);
  if (nonFirst.length) {
    console.error(`seed 必须全部为 first: ${nonFirst.map((item) => item.id).join(", ")}`);
  }
  if (!filesMatch || items.length !== publicItems.length) {
    console.error("data/seed.json 与 public/seed-data.json 不一致");
  }
  process.exit(1);
}

console.log(
  `items=${items.length} places=${new Set(items.map((item) => item.place)).size} years=[${[
    ...new Set(items.map((item) => item.date.slice(0, 4))),
  ].sort().join(",")}] required_ids=OK photos=OK`,
);
