import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.native-build/project/out/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2" };
await stat(path.join(root, "index.html"));
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const rootPath = path.resolve(root);
    let filename = path.resolve(rootPath, `.${pathname}`);
    if (filename !== rootPath && !filename.startsWith(`${rootPath}${path.sep}`)) throw new Error("Invalid path");
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, "index.html");
    if (filename.endsWith(".txt") && pathname.includes("__next.")) {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(await readFile(filename));
      return;
    }
    const body = await readFile(filename);
    response.writeHead(200, { "Content-Type": types[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(4173, "127.0.0.1", () => console.log("Offline App preview: http://localhost:4173/devices/"));
