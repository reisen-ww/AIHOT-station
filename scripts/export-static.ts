// Explicit connection string only: no dotenv loading, live worker, model call or git operation.
import { parseArgs } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStaticFiles } from "./static-files.ts";
import { staticMediaSink, type StaticIconFallback } from "./static-media.ts";
import { readFile } from "node:fs/promises";
import { staticFilePath } from "@aihot/contracts/static-manifest";

const { values } = parseArgs({ options: { station: { type: "string" }, out: { type: "string" }, "database-url": { type: "string" }, "site-url": { type: "string" }, "assets-dir": { type: "string" }, "cache-dir": { type: "string" }, "max-items": { type: "string" }, "retain-score-at-least": { type: "string" } } });
const maxItems = values["max-items"] === undefined ? undefined : Number(values["max-items"]);
if (maxItems !== undefined && (!/^[1-9][0-9]*$/.test(values["max-items"]!) || !Number.isSafeInteger(maxItems))) throw new Error("--max-items must be a positive integer");
const retainScoreAtLeast = values["retain-score-at-least"] === undefined ? undefined : Number(values["retain-score-at-least"]);
if (retainScoreAtLeast !== undefined && (maxItems === undefined || !/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(values["retain-score-at-least"]!) || !Number.isFinite(retainScoreAtLeast) || retainScoreAtLeast < 0 || retainScoreAtLeast > 100)) throw new Error("--retain-score-at-least requires --max-items and a score between 0 and 100");
if (!values.station || !values.out || !values["database-url"] || !values["site-url"]) {
  throw new Error("Required: --station <slug> --out <new directory> --database-url <explicit read connection> --site-url <public station URL>");
}
const site = new URL(values["site-url"]);
if (!/^https?:$/.test(site.protocol) || site.username || site.password || site.search || site.hash
  || !site.pathname.replace(/\/+$/, "").endsWith(`/${values.station}`)) throw new Error("invalid public site URL");
const database = new URL(values["database-url"]);
if (!/^postgres(?:ql)?:$/.test(database.protocol) || !database.pathname.slice(1)) throw new Error("invalid database URL");
process.env.DATABASE_URL = values["database-url"];
process.env.DATABASE_POOL_MAX = "1";
process.env.SITE_URL = site.href.replace(/\/$/, "");
process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
process.env.FEISHU_INTERNAL_ENABLED = "false";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
// The static asset writer will replace these proxy addresses. No production signing key is read.
process.env.IMG_PROXY_SIGN_SECRET = `static-export-${randomUUID()}`;
// Never capture the running service's .data path for an offline export.
process.env.AIHOT_DATA_DIR = path.resolve(values["cache-dir"] ?? `${values.out}.cache`);
const { exportStaticSnapshot } = await import("../packages/backend/src/publication/static.ts");
const { closeDb } = await import("../packages/backend/src/db.ts");
try {
  const revision = randomUUID();
  const directory = path.resolve(values.out);
  // Keep network/image work out of the repeatable-read transaction. The intermediate snapshot is
  // local-only, never copied into the publish tree; only the rewritten final directory may ship.
  const sourceDirectory = `${directory}.source-${revision}`;
  const source = await createStaticFiles(sourceDirectory);
  const metadata = await exportStaticSnapshot(values.station, revision, source.sink, { maxItems, retainScoreAtLeast });
  const raw = source.snapshot(metadata);
  await closeDb();
  const output = await createStaticFiles(directory, process.env.SITE_URL);
  const { staticImageResolver } = await import("./static-images.ts");
  const images = staticImageResolver(path.join(process.env.AIHOT_DATA_DIR!, "images"), values["assets-dir"] && path.resolve(values["assets-dir"]));
  const fallbacks: StaticIconFallback[] = [];
  const sink = staticMediaSink(output.sink, directory, site.pathname.replace(/\/+$/, ""), images.remote, process.env.SITE_URL, images.local, (entry) => { fallbacks.push(entry); });
  for (const [key, file] of Object.entries(raw.files)) {
    const contents = await readFile(path.join(sourceDirectory, staticFilePath(file)), "utf8");
    try {
      if (file.endsWith(".json")) await sink.json(key, JSON.parse(contents));
      else await sink.text(key, contents);
    } catch (error) { throw new Error(`static media projection failed: ${key}`, { cause: error }); }
  }
  await output.sink.json("media-fallbacks", fallbacks);
  const manifest = await output.finish(metadata);
  console.log(JSON.stringify({ station: manifest.station, revision, asOf: manifest.asOf, window: manifest.window ?? null, iconFallbacks: fallbacks.length, files: Object.keys(manifest.files).length, routes: manifest.routes.length }));
} finally {
  await closeDb();
}
