// Pure filesystem fixtures: no build, database, child process, network or git.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { publicFixture } from "../../apps/web/tests/helpers/static-fixture.ts";
import { createStaticFiles } from "../static-files.ts";
import { composeStaticSites } from "../static-compose.ts";
import { digest, staticInventory, validateStaticData } from "../static-validate.ts";
import { STATIONS, PUBLIC_SITE_URL, fingerprintSnapshot, fingerprintSources, validateCombinedRelease,
  acquireLock, readState, atomicWriteState, slotFor } from "../static-runner-core.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "hot-runner-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, file, value) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function snapshot(directory, change = () => {}, station = "aihot") {
  const fixture = publicFixture(3);
  fixture.manifest.station = station; fixture.catalog.station = station;
  change(fixture);
  const writer = await createStaticFiles(directory, `${PUBLIC_SITE_URL}/${station}`);
  for (const [file, bytes] of fixture.media) await put(directory, file, bytes);
  for (const [key, value] of fixture.data) {
    if (typeof value === "string") await writer.sink.text(key, value);
    else await writer.sink.json(key, value);
  }
  const { files: _files, ...metadata } = fixture.manifest;
  return writer.finish(metadata);
}

function addMedia(fixture, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="4" height="4"/></svg>`;
  const file = `media/${digest(svg)}.svg`;
  fixture.media.set(file, svg);
  fixture.data.get("contact").makerAvatar = `/hot-pages/${fixture.manifest.station}/data/${file}`;
}

test("snapshot fingerprints ignore only manifest/catalog envelopes and JSON object key order", async (t) => {
  const root = await workspace(t), first = path.join(root, "first"), second = path.join(root, "second");
  const original = await snapshot(first);
  const changed = await snapshot(second, (fixture) => {
    fixture.manifest.revision = fixture.catalog.revision = "another-random-revision";
    fixture.manifest.asOf = fixture.catalog.asOf = "2026-11-10T06:00:00.000Z";
    const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)])) : value;
    for (const [key, value] of fixture.data) fixture.data.set(key, reverseKeys(value));
    fixture.manifest = reverseKeys(fixture.manifest);
  });
  assert.notEqual(original.files.catalog, changed.files.catalog);
  const fingerprint = await fingerprintSnapshot(first, "aihot");
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await fingerprintSnapshot(second, "aihot"), fingerprint);
});

test("snapshot fingerprints retain prose, permissions, availability, metadata, real times and array order", async (t) => {
  const root = await workspace(t), baseline = path.join(root, "baseline");
  const nestedFields = (f) => {
    f.data.get("meta").nested = { revision: "inner-1", asOf: "2026-11-08T04:00:00Z" };
    Object.assign(f.catalog.items[0], { revision: "row-1", asOf: "2026-11-08T04:00:00Z" });
    f.manifest.nested = { revision: "metadata-1", asOf: "2026-11-08T04:00:00Z" };
  };
  await snapshot(baseline, nestedFields);
  const expected = await fingerprintSnapshot(baseline, "aihot");
  const cases = [
    ["body", (f) => { f.data.get("items/fixture-0000").body.zh += "<p>Changed body.</p>"; }],
    ["report", (f) => { f.data.get("reports/daily/2026-09-01").overview = "Corrected historical report."; }],
    ["license", (f) => {
      for (const key of ["items/fixture-0000", "items/fixture-0000/original"]) f.data.get(key).markdownAvailable = false;
      f.data.delete("markdown/fixture-0000");
    }],
    ["availability", (f) => {
      f.data.get("availability")["fixture-0000"].status = "summary-only";
      Object.assign(f.data.get("items/fixture-0000"), { readingMode: "summary-only", body: null, markdownAvailable: false, indexable: false });
      f.data.delete("items/fixture-0000/original"); f.data.delete("markdown/fixture-0000");
      f.data.set("search/body-0", f.data.get("search/body-0").filter((row) => row.id !== "fixture-0000"));
      f.manifest.routes = f.manifest.routes.filter((route) => route !== "/items/fixture-0000/original");
    }],
    ["computedAt", (f) => { f.data.get("hot").computedAt = "2026-11-08T06:00:00.000Z"; }],
    ["report-time", (f) => { f.data.get("reports/daily/2026-09-01").generatedAt = "2026-11-08T06:00:00.000Z"; }],
    ["rss-time", (f) => { f.data.set("feeds/selected", f.data.get("feeds/selected").replace("</channel>", "<lastBuildDate>Sun, 08 Nov 2026 06:00:00 GMT</lastBuildDate></channel>")); }],
    ["statistics-24h", (f) => { f.data.get("stats").day.collected++; }],
    ["nested-revision", (f) => { f.data.get("meta").nested.revision = "inner-2"; }],
    ["nested-asOf", (f) => { f.data.get("meta").nested.asOf = "2026-11-09T00:00:00Z"; }],
    ["catalog-nested-revision", (f) => { f.catalog.items[0].revision = "row-2"; }],
    ["catalog-nested-asOf", (f) => { f.catalog.items[0].asOf = "2026-11-09T00:00:00Z"; }],
    ["manifest-nested-envelope", (f) => { f.manifest.nested.revision = "metadata-2"; }],
    ["manifest-nested-asOf", (f) => { f.manifest.nested.asOf = "2026-11-09T00:00:00Z"; }],
    ["array-order", (f) => { f.catalog.items.reverse(); }],
    ["manifest-metadata", (f) => { f.manifest.reports.daily[0].title = "Changed issue index title"; }],
  ];
  for (const [name, change] of cases) {
    const directory = path.join(root, name);
    await snapshot(directory, (f) => { nestedFields(f); change(f); });
    assert.notEqual(await fingerprintSnapshot(directory, "aihot"), expected, name);
  }
});

test("snapshot fingerprints bind actual projected media and reject tampered or missing bytes", async (t) => {
  const root = await workspace(t), first = path.join(root, "first"), second = path.join(root, "second");
  const manifest = await snapshot(first, (f) => addMedia(f, "red"));
  const other = await snapshot(second, (f) => addMedia(f, "blue"));
  assert.notEqual(await fingerprintSnapshot(first, "aihot"), await fingerprintSnapshot(second, "aihot"));
  const media = (await staticInventory(first)).find((file) => file.startsWith("media/"));
  const bytes = await readFile(path.join(first, media));
  await writeFile(path.join(first, media), "broken image bytes");
  await assert.rejects(fingerprintSnapshot(first, "aihot"), /checksum/);
  await writeFile(path.join(first, media), bytes);
  await writeFile(path.join(first, manifest.files["items/fixture-0000"]), "{}");
  await assert.rejects(fingerprintSnapshot(first, "aihot"), /checksum/);
  await rm(path.join(second, other.files.contact));
  await assert.rejects(fingerprintSnapshot(second, "aihot"), /ENOENT/);
  await rm(path.join(second, "manifest.json"));
  await assert.rejects(fingerprintSnapshot(second, "aihot"), /ENOENT/);
  await assert.rejects(fingerprintSnapshot(first, "finhot"), /station/);
});

test("source fingerprints include uncommitted templates, station packages, industry, modules, fonts and public bytes", async (t) => {
  const root = await workspace(t);
  const files = ["apps/web/app/routes/home.tsx", "apps/web/app/lib/runtime.ts", "site/site.ts", "site/brand/logo.svg",
    "site/public/robots.txt", "industry/taxonomy.ts", "modules/custom/render.ts", "packages/contracts/src/site.ts",
    "scripts/export-static.ts", "assets/font.woff2", "package.json", "package-lock.json", "tsconfig.base.json"];
  for (const file of files) await put(root, file, "initial fixture bytes");
  let previous = await fingerprintSources(root);
  // No repository or git command: a new on-disk template is sufficient to change the fingerprint.
  for (const file of ["apps/web/app/routes/untracked.tsx", ...files]) {
    await put(root, file, "changed fixture bytes");
    const next = await fingerprintSources(root);
    assert.notEqual(next, previous, file); previous = next;
  }
});

test("source exclusions never follow node_modules junctions, while included source junctions are refused", async (t) => {
  const root = await workspace(t), source = path.join(root, "source"), outside = path.join(root, "outside");
  await put(source, "site/site.ts", "public source");
  await put(outside, "synthetic.txt", "excluded fixture only");
  const baseline = await fingerprintSources(source);
  const excluded = ["site/.env", "site/.env.local", "site/credentials/fixture.txt", "site/runtime/fixture.txt",
    "site/.cache/fixture.txt", "site/logs/fixture.txt", "site/tests/fixture.ts", "site/docs/fixture.md", "site/.git/config",
    "apps/web/.data/fixture.json", "apps/web/.react-router/fixture.ts", "apps/web/build/fixture.js",
    "apps/web/build-static/fixture.js", "packages/unit/__tests__/fixture.ts", "scripts/local.test.ts", "unrelated-project/site.ts"];
  for (const file of excluded) await put(source, file, "synthetic ignored bytes");
  await symlink(outside, path.join(source, "site/node_modules"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await fingerprintSources(source), baseline);
  await symlink(outside, path.join(source, "site/included-link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(fingerprintSources(source), /symlink/);
});

async function sealStation(directory, station) {
  const manifest = JSON.parse(await readFile(path.join(directory, "data/manifest.json"), "utf8"));
  const files = {}; let bytes = 0;
  for (const file of (await staticInventory(directory)).filter((file) => file !== "static-release.json")) {
    const body = await readFile(path.join(directory, file)); files[file] = digest(body); bytes += body.length;
  }
  await put(directory, "static-release.json", JSON.stringify({ schemaVersion: 1, station, revision: manifest.revision, asOf: manifest.asOf,
    files, bytes, routes: manifest.routes.length, poster: "browser-png" }));
}

async function combinedFixture(root) {
  const inputs = {};
  for (const station of STATIONS) {
    const directory = inputs[station] = path.join(root, station);
    await mkdir(directory);
    const manifest = await snapshot(path.join(directory, "data"), () => {}, station);
    await put(directory, "index.html", `<!doctype html><html><head><meta name="static-revision" content="${manifest.revision}"/>`
      + `<link rel="canonical" href="${PUBLIC_SITE_URL}/${station}/"/><meta property="og:url" content="${PUBLIC_SITE_URL}/${station}/"/>`
      + `</head><body><script src="/hot-pages/${station}/assets/main.js"></script></body></html>`);
    await put(directory, "404.html", "<!doctype html><p>Station historical address shell</p>");
    await put(directory, "assets/main.js", "/* isolated fixture */");
    await sealStation(directory, station);
  }
  const output = path.join(root, "combined");
  await composeStaticSites(inputs, output, PUBLIC_SITE_URL, 1_000_000);
  return output;
}

async function changeJSON(root, file, change) {
  const value = JSON.parse(await readFile(path.join(root, file), "utf8"));
  change(value); await put(root, file, JSON.stringify(value));
}

// Re-sign a deliberately invalid fixture to reach checks beyond the outer checksum.
async function resealCombined(root) {
  const release = JSON.parse(await readFile(path.join(root, "static-site-release.json"), "utf8"));
  release.files = {}; release.payloadBytes = 0;
  for (const entry of release.stations) entry.bytes = 0;
  for (const file of (await staticInventory(root)).filter((file) => file !== "static-site-release.json")) {
    const bytes = await readFile(path.join(root, file)); release.files[file] = digest(bytes); release.payloadBytes += bytes.length;
    const station = release.stations.find((entry) => file.startsWith(`${entry.station}/`));
    if (station) station.bytes += bytes.length;
  }
  await put(root, "static-site-release.json", JSON.stringify(release));
}

// Represents a snapshot exported by another station's own validator. The local AI exporter
// intentionally rejects these categories; the cross-station reader must use the declared feeds.
async function foreignSnapshot(directory, station, categories) {
  const fixture = publicFixture(3);
  fixture.manifest.station = fixture.catalog.station = station;
  const feed = fixture.data.get("feeds/selected");
  for (const key of [...fixture.data.keys()]) if (key.startsWith("feeds/selected/category/") || key.startsWith("feeds/full/category/")) fixture.data.delete(key);
  for (const name of ["selected", "full"]) for (const category of categories) fixture.data.set(`feeds/${name}/category/${category}`, feed);
  const writer = await createStaticFiles(directory, `${PUBLIC_SITE_URL}/${station}`);
  for (const [key, value] of fixture.data) {
    if (typeof value === "string") await writer.sink.text(key, value);
    else await writer.sink.json(key, value);
  }
  const { files: _files, ...metadata } = fixture.manifest;
  const manifest = writer.snapshot(metadata);
  await put(directory, "manifest.json", JSON.stringify(manifest));
  return manifest;
}

test("cross-station fingerprints respect foreign category feeds while the local export gate stays strict", async (t) => {
  const root = await workspace(t);
  for (const [station, categories] of [["cryptohot", ["market", "defi"]], ["acadhot", ["physics"]], ["openhot", ["dev-tools", "security"]]]) {
    const directory = path.join(root, station), manifest = await foreignSnapshot(directory, station, categories);
    await assert.rejects(validateStaticData(directory, manifest), /missing public feed/);
    assert.match(await fingerprintSnapshot(directory, station), /^[a-f0-9]{64}$/);
    delete manifest.files[`feeds/full/category/${categories[0]}`];
    await put(directory, "manifest.json", JSON.stringify(manifest));
    await assert.rejects(fingerprintSnapshot(directory, station), /missing public feed/);
  }
});

test("combined validation accepts distinct station vocabularies and still rejects unpaired or absent category feeds", async (t) => {
  const root = await workspace(t), directory = await combinedFixture(root);
  const station = path.join(directory, "cryptohot"), data = path.join(station, "data");
  await rm(data, { recursive: true });
  const manifest = await foreignSnapshot(data, "cryptohot", ["market", "defi"]);
  await sealStation(station, "cryptohot"); await resealCombined(directory);
  assert.equal((await validateCombinedRelease(directory)).release.stations.length, 4);
  delete manifest.files["feeds/selected/category/defi"];
  await put(data, "manifest.json", JSON.stringify(manifest));
  await sealStation(station, "cryptohot"); await resealCombined(directory);
  await assert.rejects(validateCombinedRelease(directory), /missing public feed/);
  for (const key of Object.keys(manifest.files)) if (key.startsWith("feeds/selected/category/") || key.startsWith("feeds/full/category/")) delete manifest.files[key];
  await put(data, "manifest.json", JSON.stringify(manifest));
  await sealStation(station, "cryptohot"); await resealCombined(directory);
  await assert.rejects(validateCombinedRelease(directory), /category feed/);
});

test("combined validation uses real compose markers and accounts for the marker's own bytes", async (t) => {
  const root = await workspace(t), directory = await combinedFixture(root);
  const result = await validateCombinedRelease(directory);
  const bytes = await readFile(path.join(directory, "static-site-release.json"));
  assert.equal(result.markerHash, digest(bytes));
  assert.equal(result.totalBytes, result.release.payloadBytes + bytes.length);
  assert.deepEqual(result.release.stations.map((entry) => entry.station), STATIONS);
  assert.equal(result.release.siteUrl, PUBLIC_SITE_URL);
  assert.deepEqual(await validateCombinedRelease(directory, PUBLIC_SITE_URL + "/"), result);
});

test("combined validation refuses changed file sets, bytes, markers, URLs, station lists and budgets", async (t) => {
  const root = await workspace(t), good = await combinedFixture(root);
  const cases = [
    ["extra", (d) => put(d, "aihot/extra.txt", "unlisted")],
    ["missing", (d) => rm(path.join(d, "aihot/assets/main.js"))],
    ["bytes", (d) => put(d, "aihot/assets/main.js", "changed")],
    ["root-404", (d) => put(d, "404.html", "lost dispatcher")],
    ["marker", (d) => put(d, "static-site-release.json", "{broken")],
    ["payload", (d) => changeJSON(d, "static-site-release.json", (r) => { r.payloadBytes++; })],
    ["domain", (d) => changeJSON(d, "static-site-release.json", (r) => { r.siteUrl = "https://wrong.test/hot-pages"; })],
    ["stations", (d) => changeJSON(d, "static-site-release.json", (r) => { r.stations[1].station = "aihot"; })],
    ["revision", (d) => changeJSON(d, "static-site-release.json", (r) => { r.stations[0].revision = "wrong-revision"; })],
    ["station-bytes", (d) => changeJSON(d, "static-site-release.json", (r) => { r.stations[0].bytes++; })],
    ["budget-excludes-marker", (d) => changeJSON(d, "static-site-release.json", (r) => { r.budgetBytes = r.payloadBytes; })],
    ["budget-limit", (d) => changeJSON(d, "static-site-release.json", (r) => { r.budgetBytes = 1_000_000_000; })],
    ["path-escape", (d) => changeJSON(d, "static-site-release.json", (r) => { r.files["../outside"] = "0".repeat(64); })],
  ];
  for (const [name, change] of cases) {
    const directory = path.join(root, `bad-${name}`); await cp(good, directory, { recursive: true });
    await change(directory);
    await assert.rejects(validateCombinedRelease(directory), undefined, name);
  }
});

test("combined validation checks nested release hashes, root navigation and publication identities after outer re-signing", async (t) => {
  const root = await workspace(t), good = await combinedFixture(root);
  const cases = [
    ["root-404", async (d) => {
      const html = await readFile(path.join(d, "404.html"), "utf8"); await put(d, "404.html", html.replace("__hot_path", "broken_path"));
    }],
    ["root-entry", async (d) => { await put(d, "index.html", "<!doctype html><p>No station links</p>"); }],
    ["station-hash", (d) => changeJSON(d, "aihot/static-release.json", (r) => { r.files["assets/main.js"] = "0".repeat(64); })],
    ["station-list", (d) => changeJSON(d, "aihot/static-release.json", (r) => { delete r.files["404.html"]; })],
    ["station-size", (d) => changeJSON(d, "aihot/static-release.json", (r) => { r.bytes++; })],
    ["station-identity", (d) => changeJSON(d, "aihot/static-release.json", (r) => { r.station = "cryptohot"; })],
    ["manifest-identity", async (d) => {
      await changeJSON(d, "aihot/data/manifest.json", (m) => { m.station = "cryptohot"; }); await sealStation(path.join(d, "aihot"), "aihot");
    }],
    ["station-domain", async (d) => {
      const html = await readFile(path.join(d, "aihot/index.html"), "utf8");
      await put(d, "aihot/index.html", html.replaceAll(PUBLIC_SITE_URL, "https://wrong.test/hot-pages"));
      await sealStation(path.join(d, "aihot"), "aihot");
    }],
  ];
  for (const [name, change] of cases) {
    const directory = path.join(root, `resigned-${name}`); await cp(good, directory, { recursive: true });
    await change(directory); await resealCombined(directory);
    await assert.rejects(validateCombinedRelease(directory), undefined, name);
  }
  const rootLink = path.join(root, "root-junction");
  await symlink(good, rootLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateCombinedRelease(rootLink), /symlink/);
  await symlink(path.join(root, "aihot"), path.join(good, "unexpected-junction"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateCombinedRelease(good), /symlink/);
});

test("cycle lock admits one owner, uses a token and releases only its own lock", async (t) => {
  const root = await workspace(t), work = path.join(root, "work");
  const pair = await Promise.all([acquireLock(work), acquireLock(work)]);
  assert.equal(pair.filter(Boolean).length, 1);
  const lock = pair.find(Boolean), ownerPath = path.join(work, "cycle.lock/owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.equal(owner.token, lock.token); assert.equal(owner.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
  await put(work, "candidate/keep.txt", "untouched");
  await writeFile(ownerPath, JSON.stringify({ ...owner, token: "another-owner" }));
  await assert.rejects(lock.release(), /token mismatch/);
  assert.ok((await lstat(path.join(work, "cycle.lock"))).isDirectory());
  await writeFile(ownerPath, JSON.stringify(owner));
  await lock.release();
  const next = await acquireLock(work); assert.ok(next);
  await lock.release(); // A repeated release must not delete the next owner's lock.
  assert.equal(await acquireLock(work), null);
  await next.release();
  assert.equal(await readFile(path.join(work, "candidate/keep.txt"), "utf8"), "untouched");
});

test("existing locks are never stolen for absent, malformed or dead owners; uncertain release retains the lock", async (t) => {
  const root = await workspace(t);
  for (const [name, contents] of [["missing", null], ["bad", "{"], ["dead", JSON.stringify({ token: "crashed-owner", pid: -1, startedAt: "2000-01-01T00:00:00Z" })]]) {
    const work = path.join(root, name); await mkdir(path.join(work, "cycle.lock"), { recursive: true });
    if (contents !== null) await put(work, "cycle.lock/owner.json", contents);
    assert.equal(await acquireLock(work), null, name);
    assert.ok((await lstat(path.join(work, "cycle.lock"))).isDirectory());
  }
  const work = path.join(root, "owner-lost"), lock = await acquireLock(work);
  await rm(path.join(work, "cycle.lock/owner.json"));
  await assert.rejects(lock.release());
  assert.equal(await acquireLock(work), null);
  const fileLock = path.join(root, "file-lock");
  await put(fileLock, "cycle.lock", "EEXIST is always busy");
  assert.equal(await acquireLock(fileLock), null);
});

test("state writes are atomic replacements in the work directory and preserve unrelated candidates", async (t) => {
  const root = await workspace(t), work = path.join(root, "work");
  assert.deepEqual(await readState(work), { schemaVersion: 1 });
  const oldState = { schemaVersion: 1, slot: 4, value: "old".repeat(2048) };
  const newState = { schemaVersion: 1, slot: 5, value: "new".repeat(2048) };
  await atomicWriteState(work, oldState);
  await put(work, "candidate/keep.txt", "untouched");
  await Promise.all([atomicWriteState(work, newState), (async () => {
    for (let i = 0; i < 20; i++) {
      const observed = await readState(work);
      assert.ok(JSON.stringify(observed) === JSON.stringify(oldState) || JSON.stringify(observed) === JSON.stringify(newState));
    }
  })()]);
  assert.deepEqual(await readState(work), newState);
  assert.deepEqual((await readdir(work)).sort(), ["candidate", "state.json"]);
  assert.equal(await readFile(path.join(work, "candidate/keep.txt"), "utf8"), "untouched");
  await assert.rejects(atomicWriteState(work, { schemaVersion: 2 }), /state/);
  assert.deepEqual(await readState(work), newState);
});

test("Windows state replacement waits briefly for a reader that denies file deletion", { skip: process.platform !== "win32" }, async (t) => {
  const root = await workspace(t), work = path.join(root, "work");
  await atomicWriteState(work, { schemaVersion: 1, value: "old" });
  const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = "$handle=[IO.File]::Open($env:STATIC_TEST_STATE_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Threading.Thread]::Sleep(200) } finally { $handle.Dispose() }";
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STATIC_TEST_STATE_PATH: path.join(work, "state.json") },
  });
  let ready, rejectReady, locked = false;
  const started = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", (error) => { rejectReady(error); reject(error); });
    child.once("close", (code) => { if (!locked) rejectReady(new Error("state reader exited before locking")); code === 0 ? resolve() : reject(new Error("state reader failed")); });
  });
  child.stderr.resume();
  child.stdout.on("data", (chunk) => { if (chunk.toString().includes("locked")) { locked = true; ready(); } });
  try {
    await started;
    await atomicWriteState(work, { schemaVersion: 1, value: "new" });
  } finally { await closed; }
  assert.deepEqual(await readState(work), { schemaVersion: 1, value: "new" });
  assert.deepEqual(await readdir(work), ["state.json"]);
});

test("corrupt state is reported without reset or replacement", async (t) => {
  const root = await workspace(t);
  for (const [index, bytes] of ["{broken", "[]", "null", '{"schemaVersion":2}'].entries()) {
    const work = path.join(root, `bad-${index}`); await put(work, "state.json", bytes);
    await assert.rejects(readState(work));
    await assert.rejects(atomicWriteState(work, { schemaVersion: 1 }));
    assert.equal(await readFile(path.join(work, "state.json"), "utf8"), bytes);
  }
});

test("two-hour UTC slots coincide with Shanghai even hours, independently of completion time", () => {
  const start = slotFor(new Date("2026-11-10T00:00:00Z"));
  assert.equal(slotFor(new Date("2026-11-10T08:00:00+08:00")), start);
  assert.equal(slotFor(new Date("2026-11-10T01:59:59.999Z")), start);
  assert.equal(slotFor(new Date("2026-11-10T02:00:00Z")), start + 1);
  assert.equal(slotFor(new Date("2026-11-10T10:00:00+08:00")), start + 1);
  assert.equal(slotFor(new Date(0)), 0);
  assert.equal(slotFor(new Date(-1)), -1);
  assert.throws(() => slotFor(new Date("invalid")), /date/);
});
