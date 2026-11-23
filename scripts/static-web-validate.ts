import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StaticManifest } from "@aihot/contracts/static";
import { digest, staticDocumentLinks, staticInventory, validateStaticData } from "./static-validate.ts";
import { staticPage } from "./static-pages.ts";

/** A release marker is written last, only after every route/resource and every byte has passed. */
export async function validateStaticWeb(client: string, m: StaticManifest, base: string, siteUrl: string) {
  await validateStaticData(path.join(client, "data"), m, siteUrl);
  const files = await staticInventory(client), present = new Set(files);
  const require = (file: string) => { if (!present.has(file)) throw new Error(`missing static web resource: ${file}`); };
  require("404.html");
  for (const file of ["icon.png", "favicon.ico", "apple-icon.png", "manifest.webmanifest", "feed.xml", "feed/full.xml", "feed/all.xml", "feed/daily.xml", "feed/weekly.xml", "feed/monthly.xml", "agent/index.md", "llms.txt", "openapi-static.json", "sitemap.xml"]) require(file);
  const url = (raw: string) => {
    const parsed = new URL(raw.replaceAll("&amp;", "&"), siteUrl + "/");
    if (parsed.origin !== new URL(siteUrl).origin) return;
    if (!parsed.pathname.startsWith(base + "/") && parsed.pathname !== base) throw new Error(`static resource escapes station: ${raw}`);
    const relative = decodeURIComponent(parsed.pathname.slice(base.length)).replace(/^\//, "");
    if (relative && !present.has(relative) && !present.has(`${relative.replace(/\/$/, "")}/index.html`)) throw new Error(`unresolved static URL: ${raw}`);
  };
  for (const route of m.routes) {
    const file = route === "/" ? "index.html" : route.slice(1) + "/index.html";
    require(file);
    const html = await readFile(path.join(client, file), "utf8");
    const page = await staticPage(route, m, path.join(client, "data"), siteUrl);
    if (!html.includes(`content="${m.revision}"`) || !html.includes(page.html) || !html.includes("window.__reactRouterContext")) throw new Error(`unbound static document: ${route}`);
    require(page.image.slice(1));
    if ((html.match(/<title\b/g) ?? []).length !== 1) throw new Error(`duplicate page metadata: ${route}`);
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (!match[1].startsWith("#")) url(match[1]);
  }
  for (const id of m.itemIds) {
    require(`og/items/${id}.png`);
    if (m.files[`markdown/${id}`]) require(`items/${id}/export.md`);
  }
  if (!files.some((file) => /^assets\/poster-client-[^/]+\.js$/.test(file))) throw new Error("missing on-demand poster renderer");
  for (const file of files) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.git|\.static-render-cache|.*\.source-.*)(?:\/|$)/.test(file)) throw new Error(`private file in static web: ${file}`);
    if (/\.(?:html|md|xml)$/.test(file) && !file.startsWith("data/")) {
      const text = await readFile(path.join(client, file), "utf8");
      if (text.includes("/api/img-proxy?")) throw new Error(`unprepared web media: ${file}`);
      for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) if (!match[1].startsWith("#")) url(match[1]);
      for (const href of staticDocumentLinks(text, file.endsWith(".md") ? "markdown" : file.endsWith(".xml") ? "xml" : "html")) {
        if (!href.startsWith("#")) url(new URL(href, `${siteUrl}/${file}`).href);
      }
    }
  }
  const hashes: Record<string, string> = {};
  let bytes = 0;
  for (const file of files.filter((file) => file !== "static-release.json")) {
    const body = await readFile(path.join(client, file));
    bytes += body.byteLength; hashes[file] = digest(body);
  }
  // This is only a station gate. The combined four-station publication must also stay below Pages' cap.
  if (bytes >= 1_000_000_000) throw new Error("station alone exceeds GitHub Pages publication limit");
  const release = { schemaVersion: 1, station: m.station, revision: m.revision, asOf: m.asOf, files: hashes, bytes, routes: m.routes.length, poster: "browser-png" };
  await writeFile(path.join(client, "static-release.json"), JSON.stringify(release), { flag: "wx" });
  return { station: m.station, revision: m.revision, routes: m.routes.length, files: files.length, bytes };
}
