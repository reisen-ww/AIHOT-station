import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStaticManifest } from "@aihot/contracts/static-manifest";

export function staticBuildConfig() {
  if (process.env.AIHOT_STATIC_BUILD !== "1") return null;
  const station = process.env.AIHOT_STATIC_STATION;
  const directory = process.env.AIHOT_STATIC_DATA;
  const site = process.env.AIHOT_STATIC_URL;
  if (!station || !directory || !site) throw new Error("Static build requires explicit AIHOT_STATIC_STATION, AIHOT_STATIC_DATA and AIHOT_STATIC_URL");
  const url = new URL(site);
  const base = url.pathname.replace(/\/+$/, "");
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password
    || !base.endsWith(`/${station}`) || !/^\/[a-zA-Z0-9_/-]+$/.test(base)) throw new Error("invalid static station URL");
  const dataDirectory = path.resolve(directory);
  const manifest = parseStaticManifest(JSON.parse(readFileSync(path.join(dataDirectory, "manifest.json"), "utf8")), station);
  return { station, dataDirectory, base, siteUrl: `${url.origin}${base}`, manifest };
}
