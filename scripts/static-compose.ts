// Combine already-verified station candidates. No git, network, DB or production directory changes.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { staticInventory } from "./static-validate.ts";
import { renderStaticPortal } from "./static-portal.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const stations = ["aihot", "cryptohot", "acadhot", "openhot"] as const;

export async function composeStaticSites(inputs: Record<string, string>, output: string, siteUrl: string, budgetBytes: number) {
  const site = new URL(siteUrl);
  if (!/^https?:$/.test(site.protocol) || site.username || site.password || site.search || site.hash
    || !/^\/[a-zA-Z0-9_-]+$/.test(site.pathname.replace(/\/$/, ""))) throw new Error("invalid Pages project URL");
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes >= 1_000_000_000) throw new Error("combined budget must stay below the Pages limit");
  if (Object.keys(inputs).sort().join(",") !== [...stations].sort().join(",")) throw new Error("exactly four station candidates required");
  const out = path.resolve(output), base = site.pathname.replace(/\/$/, "");
  const verified: Array<{ station: string; directory: string; files: string[]; hashes: Record<string, string>; bytes: number; revision: string }> = [];
  const portalSnapshots: Parameters<typeof renderStaticPortal>[1][number][] = [];
  // Check every input before creating output; stale release markers cannot bless modified files.
  for (const station of stations) {
    const directory = path.resolve(inputs[station]);
    if (out === directory || out.startsWith(directory + path.sep) || directory.startsWith(out + path.sep)) throw new Error("output overlaps a station candidate");
    const release = JSON.parse(await readFile(path.join(directory, "static-release.json"), "utf8"));
    if (release.station !== station || release.schemaVersion !== 1 || !release.files || typeof release.revision !== "string") throw new Error("invalid station release");
    const files = await staticInventory(directory);
    if (files.filter((file) => file !== "static-release.json").sort().join("\n") !== Object.keys(release.files).sort().join("\n")) throw new Error("station release file set changed");
    let bytes = 0;
    const hashes: Record<string, string> = {};
    let manifestBytes: Buffer | undefined;
    for (const file of files) {
      const body = await readFile(path.join(directory, file));
      hashes[file] = hash(body);
      if (file !== "static-release.json" && hashes[file] !== release.files[file]) throw new Error(`station release bytes changed: ${station}/${file}`);
      if (file === "data/manifest.json") manifestBytes = body;
      bytes += body.byteLength;
    }
    if (!manifestBytes) throw new Error("station manifest missing from verified release");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.station !== station || manifest.revision !== release.revision || !files.includes("404.html")) throw new Error("station manifest/404 is not release-bound");
    portalSnapshots.push({ station, manifest });
    const html = await readFile(path.join(directory, "index.html"), "utf8");
    if (!html.includes(`${base}/${station}/assets/`)) throw new Error("station uses another publication base");
    verified.push({ station, directory, files, hashes, bytes, revision: release.revision });
  }
  await mkdir(out); // Refuse replacing an old candidate or any online tree.
  for (const candidate of verified) for (const file of candidate.files) {
    const destination = path.join(out, candidate.station, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(candidate.directory, file), destination);
    if (hash(await readFile(destination)) !== candidate.hashes[file]) throw new Error(`station changed during composition: ${candidate.station}/${file}`);
  }
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const links = stations.map((station) => `<li><a href="${base}/${station}/">${station}</a></li>`).join("");
  await writeFile(path.join(out, "index.html"), renderStaticPortal(site.origin + base, portalSnapshots));
  const boot = `const b=${JSON.stringify(base)},s=${JSON.stringify(stations)};const p=location.pathname.split('/');const i=p.indexOf(b.slice(1));const n=p[i+1];if(i===1&&s.includes(n)&&location.pathname!==b+'/'+n+'/404.html'){location.replace(b+'/'+n+'/404.html?__hot_path='+encodeURIComponent(location.pathname+location.search+location.hash));}`;
  await writeFile(path.join(out, "404.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>历史地址</title><p>正在检查历史地址；旧文章可能已超出当前在线窗口。</p><script>${boot}</script><noscript>请开启JavaScript查看窗口状态，或选择站点继续阅读。</noscript><ul>${links}</ul><p>${escape(site.origin + base)}</p></html>`);
  await writeFile(path.join(out, ".nojekyll"), "");
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const file of await staticInventory(out)) {
    const body = await readFile(path.join(out, file)); bytes += body.byteLength; files[file] = hash(body);
  }
  const release = { schemaVersion: 1, siteUrl: site.origin + base, budgetBytes, payloadBytes: bytes, files,
    stations: verified.map(({ station, bytes, revision }) => ({ station, bytes, revision })) };
  const marker = JSON.stringify(release);
  const totalBytes = bytes + Buffer.byteLength(marker);
  if (totalBytes > budgetBytes || totalBytes >= 1_000_000_000) throw new Error(`combined candidate ${totalBytes} bytes exceeds budget ${budgetBytes}`);
  await writeFile(path.join(out, "static-site-release.json"), marker, { flag: "wx" });
  return { directory: out, files: Object.keys(files).length + 1, bytes: totalBytes, budgetBytes, stations: release.stations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { station: { type: "string", multiple: true }, out: { type: "string" }, "site-url": { type: "string" }, "budget-bytes": { type: "string" } } });
  if (!values.out || !values["site-url"] || !values["budget-bytes"]) throw new Error("requires --out <new path> --site-url <project URL> --budget-bytes <explicit combined limit> --station <slug=client path> (four times)");
  const inputs = Object.fromEntries((values.station ?? []).map((entry) => { const at = entry.indexOf("="); if (at < 1) throw new Error("invalid station input"); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  console.log(JSON.stringify(await composeStaticSites(inputs, values.out, values["site-url"], Number(values["budget-bytes"]))));
}
