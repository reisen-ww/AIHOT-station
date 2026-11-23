// Isolated file-only preview. Missing documents use a Pages-style custom 404, keeping HTTP 404.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function staticPreview(directory: string, base: string) {
  const root = path.resolve(directory), prefix = base.replace(/\/+$/, "");
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
    ".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json" };
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return; }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative.includes("\\") || relative.split("/").some((s) => s === ".." || s === ".")) { res.writeHead(400).end(); return; }
      let file = path.resolve(root, `.${relative || "/"}`), info = await stat(file).catch(() => null);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(400).end(); return; }
      if (info?.isDirectory()) {
        if (!url.pathname.endsWith("/")) { res.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end(); return; }
        file = path.join(file, "index.html");
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) {
        // Missing data/assets are genuine errors, never a successful application shell.
        if (req.headers.accept?.includes("text/html") && !relative.startsWith("/data/") && !relative.startsWith("/assets/")) {
          const fallback = path.join(root, "404.html");
          const missing = await stat(fallback).catch(() => null);
          if (missing?.isFile()) {
            res.writeHead(404, { "Content-Type": types[".html"], "Content-Length": missing.size, "Cache-Control": "no-store" });
            if (req.method === "HEAD") res.end(); else createReadStream(fallback).on("error", () => res.destroy()).pipe(res);
            return;
          }
        }
        res.writeHead(404).end(); return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch { res.writeHead(400).end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, base: { type: "string" }, port: { type: "string", default: "0" } } });
  if (!values.dir || !values.base || !/^\/[a-zA-Z0-9_/-]+$/.test(values.base)) throw new Error("Requires --dir <built client> --base /hot-pages/<station>");
  const server = staticPreview(values.dir, values.base);
  server.listen(Number(values.port), "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, address: server.address(), base: values.base })));
}
