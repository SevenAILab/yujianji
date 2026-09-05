import { cp, mkdir, readFile, readdir, realpath, rm, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const generatedRoot = path.join(root, ".native-build");
await mkdir(generatedRoot, { recursive: true });
if (await realpath(generatedRoot) !== generatedRoot) throw new Error("Refusing linked build directory");
const project = path.join(generatedRoot, "project");
const existing = await lstat(project).catch(() => null);
if (existing?.isSymbolicLink()) throw new Error("Refusing linked build project");
await rm(project, { recursive: true, force: true });
await mkdir(project, { recursive: true });
await cp(path.join(root, "src"), path.join(project, "src"), {
  recursive: true,
  filter: (source) => !["app/api", "app/item/[id]"].includes(path.relative(path.join(root, "src"), source).split(path.sep).join("/")),
});
for (const filename of ["public", "postcss.config.mjs"]) {
  await cp(path.join(root, filename), path.join(project, filename), { recursive: true });
}
const typescript = JSON.parse(await readFile(path.join(root, "tsconfig.json"), "utf8"));
typescript.exclude = ["node_modules"];
await writeFile(path.join(project, "tsconfig.json"), JSON.stringify(typescript, null, 2));
await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "yujianji-offline", private: true }));
await writeFile(path.join(project, "next.config.mjs"), `export default {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_LOCAL_ONLY: "true" },
  turbopack: { root: ${JSON.stringify(root)} }
};\n`);
const result = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", project], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_LOCAL_ONLY: "true" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'";
const output = path.join(project, "out");
async function protectHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await protectHtml(filename);
    else if (entry.name.endsWith(".html")) {
      const html = await readFile(filename, "utf8");
      await writeFile(filename, html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`));
    }
  }
}
await protectHtml(output);
for (const route of ["index.html", "devices/index.html", "trip/index.html", "encounter/index.html", "item/index.html"]) {
  await readFile(path.join(output, route));
}
console.log(`Offline pages ready: ${output}`);
