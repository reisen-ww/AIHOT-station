// Local, side-effect-bounded helpers for the four-station cycle. No git or process control.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseStaticManifest } from "../packages/contracts/src/static-manifest.ts";
import { digest, staticInventory, validateStaticData } from "./static-validate.ts";

export const STATIONS = Object.freeze(["aihot", "cryptohot", "acadhot", "openhot"]);
export const PUBLIC_SITE_URL = "https://reisen-ww.github.io/hot-pages";
const PAGE_LIMIT = 1_000_000_000;
const COMBINED_MARKER = "static-site-release.json";
const STATION_MARKER = "static-release.json";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

// Sorting object keys never changes array order or removes similarly named nested fields.
function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function optionalStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Check ancestors before creating/reading a descendant, including Windows junctions.
async function directoryRoot(directory, create = false) {
  const root = path.resolve(directory), anchor = path.parse(root).root;
  let current = anchor;
  for (const part of ["", ...root.slice(anchor.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat = await optionalStat(current);
    if (!stat && create) {
      try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await lstat(current);
    }
    if (!stat) { const error = new Error(`missing directory: ${current}`); error.code = "ENOENT"; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`directory symlink or non-directory refused: ${current}`);
  }
  return root;
}

function relativePath(file) {
  if (typeof file !== "string" || !file || /[\\:\x00-\x1f]/.test(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)
    || file.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error(`unsafe release path: ${file}`);
  return file;
}

function exactFiles(actual, expected, label) {
  if (!record(expected)) throw new Error(`invalid ${label} file list`);
  for (const [file, hash] of Object.entries(expected)) {
    relativePath(file);
    if (!sha256(hash)) throw new Error(`invalid ${label} checksum: ${file}`);
  }
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error(`${label} file set changed`);
}

function snapshotCategoryKeys(manifest) {
  const categories = new Set();
  for (const key of Object.keys(manifest.files)) {
    const parts = key.split("/");
    if (parts[0] !== "feeds" || !["selected", "full"].includes(parts[1]) || parts[2] !== "category") continue;
    if (parts.length !== 4 || !/^[a-zA-Z0-9_-]+$/.test(parts[3])) throw new Error("invalid public category feed");
    categories.add(parts[3]);
  }
  if (!categories.size) throw new Error("missing public category feeds");
  // The data validator requires both selected/full for every declared category. The station's
  // own export/build gate separately requires its complete configured industry vocabulary.
  return [...categories].sort();
}

export async function fingerprintSnapshot(directory, station) {
  if (!STATIONS.includes(station)) throw new Error("unknown snapshot station");
  const root = await directoryRoot(directory);
  // Inventory before opening the manifest also refuses a symlinked manifest.
  const initialInventory = await staticInventory(root);
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifest = parseStaticManifest(JSON.parse(manifestBytes.toString("utf8")), station);
  await validateStaticData(root, manifest, `${PUBLIC_SITE_URL}/${station}`, snapshotCategoryKeys(manifest));
  const files = {};
  for (const key of Object.keys(manifest.files).sort()) {
    const file = manifest.files[key], bytes = await readFile(path.join(root, file));
    if (digest(bytes) !== path.posix.basename(file).split(".")[0]) throw new Error(`snapshot bytes changed: ${key}`);
    if (file.endsWith(".json")) {
      const value = JSON.parse(bytes.toString("utf8"));
      if (key === "catalog") { delete value.revision; delete value.asOf; }
      files[key] = { format: "json", hash: digest(stableJSON(value)) };
    } else files[key] = { format: "md", hash: digest(bytes) };
  }
  const media = {}, allowed = new Set(["manifest.json", ...Object.values(manifest.files)]);
  const finalInventory = await staticInventory(root);
  if (JSON.stringify(finalInventory) !== JSON.stringify(initialInventory)) throw new Error("snapshot file set changed during fingerprint");
  for (const file of finalInventory) {
    if (allowed.has(file)) continue;
    if (!/^media\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg|avif)$/.test(file)) throw new Error(`unlisted snapshot file: ${file}`);
    const bytes = await readFile(path.join(root, file)), hash = digest(bytes);
    if (!bytes.length || hash !== path.posix.basename(file).split(".")[0]) throw new Error(`snapshot media changed: ${file}`);
    media[file] = hash;
  }
  if (!(await readFile(path.join(root, "manifest.json"))).equals(manifestBytes)) throw new Error("snapshot manifest changed during fingerprint");
  const { revision: _revision, asOf: _asOf, ...metadata } = manifest;
  return digest(stableJSON({ manifest: { ...metadata, files }, media }));
}

const SOURCE_TREES = ["apps/web", "packages", "site", "industry", "modules", "scripts", "assets"];
const SOURCE_FILES = ["package.json", "package-lock.json", "tsconfig.base.json"];
const EXCLUDED_NAMES = new Set(["node_modules", ".git", ".data", ".react-router", "build", "build-static", "tests", "test", "__tests__", "docs"]);
function excludedSource(name, directory) {
  const lower = name.toLowerCase();
  return EXCLUDED_NAMES.has(lower) || lower === ".env" || lower.startsWith(".env.")
    || /(?:^|[._-])credentials?(?:[._-]|$)/.test(lower)
    || (directory && /(?:^|[._-])(?:runtime|cache|logs?)(?:[._-]|$)/.test(lower))
    // Local deployment backups sit next to the files they replaced; they are never imported,
    // but a cycle that spans a deploy must not be invalidated by one.
    || /\.(?:bak|orig|rej)$/.test(lower) || /\.before-/.test(lower)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower);
}

export async function fingerprintSources(directory) {
  const root = await directoryRoot(directory), files = [];
  const visit = async (relative, directory = true, fileOnly = false) => {
    // Exclusions precede lstat: an excluded node_modules junction is never followed.
    if (excludedSource(path.posix.basename(relative), directory)) return;
    const target = path.join(root, relative), stat = await optionalStat(target);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`source symlink refused: ${relative}`);
    if (fileOnly && !stat.isFile()) throw new Error(`source root file is not a file: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(target, { withFileTypes: true })) await visit(`${relative}/${entry.name}`, entry.isDirectory() || entry.isSymbolicLink());
    } else if (stat.isFile()) files.push([relative, digest(await readFile(target))]);
    else throw new Error(`unsupported source entry: ${relative}`);
  };
  // apps itself is not traversed; check that the whitelisted web subtree cannot escape through it.
  const apps = await optionalStat(path.join(root, "apps"));
  if (apps && (apps.isSymbolicLink() || !apps.isDirectory())) throw new Error("source apps directory symlink refused");
  for (const relative of SOURCE_TREES) await visit(relative);
  for (const relative of SOURCE_FILES) await visit(relative, false, true);
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return digest(stableJSON(files));
}

function projectURL(value) {
  const site = new URL(value), base = site.pathname.replace(/\/$/, "");
  if (!/^https?:$/.test(site.protocol) || site.username || site.password || site.search || site.hash || !/^\/[a-zA-Z0-9_-]+$/.test(base)) throw new Error("invalid expected Pages project URL");
  return { siteUrl: site.origin + base, base };
}

export async function validateCombinedRelease(directory, expectedSiteUrl = PUBLIC_SITE_URL) {
  const root = await directoryRoot(directory), { siteUrl, base } = projectURL(expectedSiteUrl);
  const inventory = await staticInventory(root);
  const markerBytes = await readFile(path.join(root, COMBINED_MARKER));
  const release = JSON.parse(markerBytes.toString("utf8"));
  if (!record(release) || release.schemaVersion !== 1 || release.siteUrl !== siteUrl
    || !Number.isSafeInteger(release.budgetBytes) || release.budgetBytes < 1 || release.budgetBytes >= PAGE_LIMIT
    || !nonnegativeInteger(release.payloadBytes) || !Array.isArray(release.stations)) throw new Error("invalid combined release URL, budget or metadata");
  exactFiles(inventory.filter((file) => file !== COMBINED_MARKER), release.files, "combined release");
  if (release.stations.length !== STATIONS.length || new Set(release.stations.map((entry) => entry?.station)).size !== STATIONS.length
    || release.stations.some((entry) => !record(entry) || !STATIONS.includes(entry.station) || !nonnegativeInteger(entry.bytes)
      || typeof entry.revision !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.revision))) throw new Error("invalid combined station identities");
  const hashes = new Map(), sizes = new Map();
  let payloadBytes = 0;
  for (const file of Object.keys(release.files).sort()) {
    const top = file.split("/")[0];
    if (!["index.html", "404.html", ".nojekyll"].includes(file) && !STATIONS.includes(top)) throw new Error(`unexpected release root file: ${file}`);
    const bytes = await readFile(path.join(root, file)), hash = digest(bytes);
    if (hash !== release.files[file]) throw new Error(`combined release checksum changed: ${file}`);
    hashes.set(file, hash); sizes.set(file, bytes.length); payloadBytes += bytes.length;
  }
  const totalBytes = payloadBytes + markerBytes.length;
  if (payloadBytes !== release.payloadBytes || !Number.isSafeInteger(totalBytes) || totalBytes > release.budgetBytes || totalBytes >= PAGE_LIMIT) throw new Error("combined release bytes or budget mismatch");
  const readVerified = async (file) => {
    if (!hashes.has(file)) throw new Error(`missing release file: ${file}`);
    const bytes = await readFile(path.join(root, file));
    if (digest(bytes) !== hashes.get(file)) throw new Error(`release changed during validation: ${file}`);
    return bytes.toString("utf8");
  };
  const index = await readVerified("index.html"), missing = await readVerified("404.html");
  if (sizes.get(".nojekyll") !== 0) throw new Error("missing or invalid root .nojekyll");
  for (const station of STATIONS) for (const html of [index, missing]) {
    if (!html.includes(`href="${base}/${station}/"`)) throw new Error("invalid root station entry links");
  }
  // Bind the historical-address dispatcher to the current compose contract, not just a marker.
  const boot = `const b=${JSON.stringify(base)},s=${JSON.stringify(STATIONS)};const p=location.pathname.split('/');const i=p.indexOf(b.slice(1));const n=p[i+1];if(i===1&&s.includes(n)&&location.pathname!==b+'/'+n+'/404.html'){location.replace(b+'/'+n+'/404.html?__hot_path='+encodeURIComponent(location.pathname+location.search+location.hash));}`;
  if (!missing.includes(`<script>${boot}</script>`) || !missing.includes(siteUrl)) throw new Error("invalid root 404 dispatcher or URL");
  for (const station of STATIONS) {
    const prefix = `${station}/`, summary = release.stations.find((entry) => entry.station === station);
    const stationFiles = [...hashes.keys()].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
    const marker = JSON.parse(await readVerified(prefix + STATION_MARKER));
    if (!record(marker) || marker.schemaVersion !== 1 || marker.station !== station || marker.revision !== summary.revision
      || !nonnegativeInteger(marker.bytes) || !nonnegativeInteger(marker.routes) || marker.poster !== "browser-png") throw new Error(`invalid station release: ${station}`);
    exactFiles(stationFiles.filter((file) => file !== STATION_MARKER), marker.files, `${station} release`);
    let stationBytes = 0;
    for (const file of stationFiles) {
      stationBytes += sizes.get(prefix + file);
      if (file !== STATION_MARKER && marker.files[file] !== hashes.get(prefix + file)) throw new Error(`station release checksum changed: ${station}/${file}`);
    }
    if (stationBytes !== summary.bytes || stationBytes - sizes.get(prefix + STATION_MARKER) !== marker.bytes) throw new Error(`station release bytes mismatch: ${station}`);
    const manifest = parseStaticManifest(JSON.parse(await readVerified(prefix + "data/manifest.json")), station);
    if (manifest.revision !== marker.revision || manifest.asOf !== marker.asOf || manifest.routes.length !== marker.routes) throw new Error(`station manifest is not release-bound: ${station}`);
    const html = await readVerified(prefix + "index.html");
    await readVerified(prefix + "404.html");
    if (!html.includes(`${base}/${station}/assets/`) || !html.includes(`content="${manifest.revision}"`)
      || !html.includes(`rel="canonical" href="${siteUrl}/${station}/"`)
      || !html.includes(`property="og:url" content="${siteUrl}/${station}/"`)) throw new Error(`station publication URL or revision mismatch: ${station}`);
    await validateStaticData(path.join(root, station, "data"), manifest, `${siteUrl}/${station}`, snapshotCategoryKeys(manifest));
  }
  if (JSON.stringify(await staticInventory(root)) !== JSON.stringify(inventory)) throw new Error("combined file set changed during validation");
  if (!(await readFile(path.join(root, COMBINED_MARKER))).equals(markerBytes)) throw new Error("combined marker changed during validation");
  return { release, markerHash: digest(markerBytes), totalBytes };
}

function lockTarget(root) {
  const target = path.resolve(root, "cycle.lock");
  if (target === root || path.relative(root, target) !== "cycle.lock") throw new Error("unsafe cycle lock target");
  return target;
}

export async function acquireLock(workDirectory) {
  const root = await directoryRoot(workDirectory, true), target = lockTarget(root);
  try { await mkdir(target); } catch (error) { if (error.code === "EEXIST") return null; throw error; }
  const token = randomUUID();
  // A failed owner write intentionally leaves a blocking lock for explicit operator recovery.
  await writeFile(path.join(target, "owner.json"), JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  let released = false;
  return { token, release: async () => {
    if (released) return;
    await directoryRoot(root);
    if (lockTarget(root) !== target) throw new Error("cycle lock target changed");
    const stat = await lstat(target), ownerPath = path.join(target, "owner.json");
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("cycle lock directory changed; retained");
    const ownerStat = await lstat(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) throw new Error("unknown cycle lock owner; retained");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (!record(owner) || owner.token !== token) throw new Error("cycle lock owner token mismatch; retained");
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt))) throw new Error("unknown cycle lock owner; retained");
    // This exact absolute target is our own lock, never a candidate or a caller-supplied child.
    await rm(target, { recursive: true });
    released = true;
  } };
}

function stateObject(value) {
  if (!record(value) || value.schemaVersion !== 1) throw new Error("invalid static cycle state");
  return value;
}

export async function readState(workDirectory) {
  let root;
  try { root = await directoryRoot(workDirectory); } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1 }; throw error; }
  const file = path.join(root, "state.json"), stat = await optionalStat(file);
  if (!stat) return { schemaVersion: 1 };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("cycle state symlink or non-file refused");
  return stateObject(JSON.parse(await readFile(file, "utf8")));
}

export async function atomicWriteState(workDirectory, state) {
  const text = JSON.stringify(stateObject(state)) + "\n";
  stateObject(JSON.parse(text));
  const root = await directoryRoot(workDirectory, true);
  await readState(root); // Never silently replace a corrupt or redirected state.
  const temporary = path.join(root, `.state-${randomUUID()}.tmp`), destination = path.join(root, "state.json");
  let handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close(); handle = null;
    for (let attempt = 0; ; attempt++) {
      await readState(root);
      try { await rename(temporary, destination); break; }
      catch (error) {
        // Windows readers can temporarily deny replace/delete sharing. Retry the same atomic
        // rename for at most 620ms; never unlink the old state or accept a corrupt destination.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

export function slotFor(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("invalid cycle date");
  return Math.floor(date.getTime() / (2 * 60 * 60 * 1000));
}
