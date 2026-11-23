// Fixed public resources use the same station pack as the dynamic server, with the Pages base applied.
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EDITION_TIMES, SITE } from "@aihot/site";
import { PUBLIC_API_CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";

export async function writeStaticResources(client: string, siteUrl: string, base: string) {
  const root = path.resolve(import.meta.dirname, "..");
  const values: Record<string, string> = { siteName: SITE.name, siteUrl, description: SITE.description, tagline: SITE.tagline, locale: SITE.locale,
    dailyTime: EDITION_TIMES.daily, weeklyTime: EDITION_TIMES.weekly, monthlyTime: EDITION_TIMES.monthly,
    version: PUBLIC_INTERFACE_VERSION, categoryList: PUBLIC_API_CATEGORY_KEYS.join(", ") };
  async function copy(directory: string, destination: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = path.join(directory, entry.name), to = path.join(destination, entry.name);
      if (["openapi-v1.json", "robots.txt"].includes(entry.name)) continue;
      if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await copy(from, to); continue; }
      if (!entry.isFile() || /\.(tsx?|env)$/.test(entry.name)) continue;
      if (/\.(json|txt|webmanifest)$/.test(entry.name)) {
        const json = /\.(json|webmanifest)$/.test(entry.name);
        let text = (await readFile(from, "utf8")).replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] === undefined ? match : json ? JSON.stringify(values[key]).slice(1, -1) : values[key]);
        if (json) {
          const value = JSON.parse(text);
          const walk = (node: any) => {
            if (!node || typeof node !== "object") return;
            for (const key of ["enum", "examples"]) if (Array.isArray(node[key]) && node[key].includes("{{categories}}")) node[key] = [...PUBLIC_API_CATEGORY_KEYS];
            Object.values(node).forEach(walk);
          };
          walk(value);
          if (entry.name === "manifest.webmanifest") {
            value.start_url = `${base}/`; value.scope = `${base}/`;
            for (const icon of value.icons ?? []) if (icon.src?.startsWith("/")) icon.src = `${base}${icon.src}`;
          }
          text = JSON.stringify(value);
        }
        await writeFile(to, text);
      } else await cp(from, to, { errorOnExist: false });
    }
  }
  await copy(path.join(root, "site/public"), client);
  await copy(path.join(root, "site/brand"), client);
  await writeFile(path.join(client, "robots.txt"), `User-agent: *\nDisallow: ${base}/admin\nDisallow: ${base}/starred\nSitemap: ${siteUrl}/sitemap.xml\n`);
  // The dynamic OpenAPI document promises queryable server endpoints. The static discovery document
  // instead describes the immutable files actually served; never advertise a fake MCP/HTTP service.
  await writeFile(path.join(client, "openapi-static.json"), JSON.stringify({ openapi: "3.1.0", info: { title: `${SITE.name} 静态公开快照`, version: "1" }, servers: [{ url: siteUrl }],
    paths: { "/data/manifest.json": { get: { summary: "版本、在线文章窗口、完整历史报告与阅读路由", responses: { "200": { description: "同版本公开快照 manifest" } } } },
      "/agent/index.md": { get: { summary: "静态读取说明", responses: { "200": { description: "Markdown" } } } } } }));
}
