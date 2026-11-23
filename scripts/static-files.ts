// One fresh output directory per export. The manifest is written only after all public files succeed.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StaticManifest, StaticSink } from "@aihot/contracts/static";
import { parseStaticManifest } from "@aihot/contracts/static-manifest";
import { validateStaticData } from "./static-validate.ts";

export async function createStaticFiles(directory: string, siteUrl?: string) {
  // recursive:false deliberately refuses an existing artifact; never overwrite a known-good version.
  await mkdir(directory, { recursive: false });
  const files: Record<string, string> = {};
  const write = async (key: string, contents: string, extension: "json" | "md") => {
    if (!/^[a-zA-Z0-9_/-]+$/.test(key) || key.split("/").some((s) => !s) || Object.hasOwn(files, key)) throw new Error(`invalid or duplicate file key: ${key}`);
    const hash = createHash("sha256").update(contents).digest("hex");
    const relative = `${extension}/${hash}.${extension}`;
    await mkdir(path.join(directory, extension), { recursive: true });
    await writeFile(path.join(directory, relative), contents, "utf8");
    files[key] = relative;
  };
  const sink: StaticSink = {
    json: (key, value) => write(key, JSON.stringify(value), "json"),
    text: (key, value) => write(key, value, "md"),
  };
  return {
    sink,
    // Intermediate local source data is deliberately not a publishable manifest.
    snapshot: (metadata: Omit<StaticManifest, "files">) => parseStaticManifest({ ...metadata, files }, metadata.station),
    async finish(metadata: Omit<StaticManifest, "files">) {
      const manifest = parseStaticManifest({ ...metadata, files }, metadata.station);
      await validateStaticData(directory, manifest, siteUrl);
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest), { encoding: "utf8", flag: "wx" });
      return manifest;
    },
  };
}
