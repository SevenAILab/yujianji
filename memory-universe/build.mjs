// 精神图景模块打包：源码在 memory-universe/，产物进 public/memory-universe/（随仓库提交，服务器不用再打包）。
// three / d3-geo / topojson-client / 世界地图数据全部打进 app.bundle.js，不依赖 jsdelivr。
// 用法：node memory-universe/build.mjs
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../public/memory-universe");
const stamp = Date.now().toString(36);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(here, "app.js")],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2020", "safari15"],
  loader: { ".json": "json" },
  outfile: path.join(out, "app.bundle.js"),
  legalComments: "none",
});
await copyFile(path.join(here, "styles.css"), path.join(out, "styles.css"));
const html = (await readFile(path.join(here, "index.html"), "utf8")).replaceAll("__BUILD__", stamp);
await writeFile(path.join(out, "index.html"), html);
console.log(`memory-universe built (${stamp})`);
