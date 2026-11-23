// Materialise every known URL on a host without rewrites. Directory indexes preserve queries on refresh.
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StaticManifest } from "@aihot/contracts/static";
import { parseStaticManifest, staticFilePath } from "@aihot/contracts/static-manifest";
import { staticPage } from "./static-pages.ts";
import { writeStaticResources } from "./static-resources.ts";
import { writeStaticExits } from "./static-exits.ts";
import { writeStaticSharing } from "./static-sharing.ts";
import { staticInventory, validateStaticData } from "./static-validate.ts";
import { validateStaticWeb } from "./static-web-validate.ts";

export async function finishStaticWeb(clientDirectory: string, dataDirectory: string, station: string, base: string, siteUrl: string) {
  const manifest = parseStaticManifest(JSON.parse(await readFile(path.join(dataDirectory, "manifest.json"), "utf8")), station);
  await validateStaticData(dataDirectory, manifest, siteUrl);
  try {
  const html = await readFile(path.join(clientDirectory, "index.html"), "utf8");
  if (!html.includes(`content="${manifest.revision}"`) || !html.includes("window.__reactRouterContext")
    || !html.includes(`${base}/assets/`)) throw new Error("static document is not bound to the current snapshot/base");
  // No catch-all redirect to the home page: every exported detail, issue, alias and topic page exists.
  // A Pages custom 404 preserves missing historical paths for the availability explanation.
  await writeFile(path.join(clientDirectory, "404.html"), html.replace("</head>", '<meta name="robots" content="noindex, follow"/></head>'));
  for (const route of manifest.routes) {
    const directory = path.join(clientDirectory, route.slice(1));
    await mkdir(directory, { recursive: true });
    const meta = await staticPage(route, manifest, dataDirectory, siteUrl);
    await writeFile(path.join(directory, "index.html"), html.replace("</head>", `${meta.html}</head>`));
  }
  for (const file of await staticInventory(dataDirectory)) {
    const destination = path.join(clientDirectory, "data", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(dataDirectory, file), destination);
  }
  for (const id of manifest.itemIds) {
    const markdown = manifest.files[`markdown/${id}`];
    if (!markdown) continue;
    const directory = path.join(clientDirectory, "items", id, "markdown");
    await mkdir(directory, { recursive: true });
    await copyFile(path.join(dataDirectory, staticFilePath(markdown)), path.join(directory, "index.md"));
    // GitHub Pages does not content-negotiate index.md. A stable extension URL is used by the controls.
    await copyFile(path.join(dataDirectory, markdown), path.join(clientDirectory, "items", id, "export.md"));
  }
  await writeStaticResources(clientDirectory, siteUrl, base);
  await writeStaticExits(clientDirectory, dataDirectory, manifest, siteUrl);
  await writeStaticSharing(clientDirectory, dataDirectory, manifest, siteUrl);
  await writeFile(path.join(clientDirectory, ".nojekyll"), "");
  return await validateStaticWeb(clientDirectory, manifest, base, siteUrl);
  } catch (error) {
    // Only our generated publication markers are removed. Source data and the failed tree stay for diagnosis.
    for (const file of ["static-release.json", "data/manifest.json"]) await unlink(path.join(clientDirectory, file)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    throw error;
  }
}
