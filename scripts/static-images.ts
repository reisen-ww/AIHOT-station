// Offline media preparation reuses image transforms, not the online proxy's DB-backed budget ledger.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { guardedFetch } from "../packages/backend/src/lib/http-fetch.ts";
import { resizeImage } from "../packages/backend/src/media/images.ts";
import { IMAGE_WIDTHS } from "../packages/backend/src/media/renditions.ts";
import type { StaticMedia } from "./static-media.ts";

export function staticImageResolver(cacheDirectory: string, assetsDirectory?: string) {
  let previous: { url: string; body: Buffer; type: string } | null = null;
  return {
    async remote(url: string, mode: string): Promise<StaticMedia> {
      if (!Object.hasOwn(IMAGE_WIDTHS, mode)) throw new Error("unknown public image rendition");
      const file = path.join(cacheDirectory, createHash("sha256").update(`${mode}|${url}`).digest("hex") + ".json");
      try {
        const cached = JSON.parse(await readFile(file, "utf8"));
        const body = Buffer.from(cached.body, "base64");
        if (createHash("sha256").update(body).digest("hex") === cached.hash && body.length) return { body, type: cached.type };
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (previous?.url !== url) {
        const res = await guardedFetch(url, { timeoutMs: 20000, maxBytes: 15 * 1024 * 1024, headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
        if (res.status !== 200) throw new Error(`static image upstream ${res.status}`);
        previous = { url, body: res.body, type: res.headers.get("content-type") ?? "" };
      }
      const image = await resizeImage(previous.body, previous.type, mode);
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(file, JSON.stringify({ type: image.type, body: image.body.toString("base64"), hash: createHash("sha256").update(image.body).digest("hex") }));
      return image;
    },
    async local(url: string): Promise<StaticMedia> {
      if (!/^\/contact\/[\w-][\w.-]*\.(?:png|jpe?g|webp)$/.test(url) || url.includes("..")) throw new Error("unsafe contact asset");
      const file = path.basename(url), pack = path.resolve(import.meta.dirname, "../site/brand/contact", file);
      const body = assetsDirectory ? await readFile(path.join(assetsDirectory, "uploads", file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return readFile(pack);
      }) : await readFile(pack);
      const extension = path.extname(file).toLowerCase();
      return { body, type: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg" };
    },
  };
}
